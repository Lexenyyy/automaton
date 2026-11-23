/**
 * USDC transfers with code-enforced limits (fork, Phase 3 step 3).
 *
 * The send_usdc tool calls sendUsdc(). Every check happens here, in code,
 * before anything is signed:
 *   1. amount: whole cents (1 cent = 0.01 USDC), 1..maxSingleTransferCents
 *   2. recipient: a valid address on the owner's transferAllowlist ("creator"
 *      resolved), never the agent's own address
 *   3. UTC clock-hour and UTC-day windows (spend_tracking, category "transfer")
 *   4. the token reports 6 decimals (USDC); anything else is refused
 *   5. fresh on-chain USDC balance >= amount + minimumReserveCents
 *   6. ETH balance covers twice the estimated network fee
 * Only the active network (testnet unless the owner approved mainnet) is used.
 *
 * Accounting: the spend is recorded BEFORE broadcasting (a crash after the
 * broadcast must not free the limit). It is removed again only when nothing
 * was sent, or the transaction reverted (no USDC moved). Each broadcast is
 * stored in onchain_transactions (pending → confirmed/failed). The wallet
 * balance itself is read on chain, so no ledger entry is written.
 * One transfer at a time per process.
 */

import { ulid } from "ulid";
import { createPublicClient, createWalletClient, http, isAddress, type Address, type PrivateKeyAccount } from "viem";
import type BetterSqlite3 from "better-sqlite3";
import { DEFAULT_TREASURY_POLICY, type ToolContext, type TreasuryPolicy } from "../types.js";
import { getActiveNetwork, type NetworkInfo } from "../identity/network.js";
import { usdcAddressFor } from "../conway/x402.js";
import { SpendTracker } from "./spend-tracker.js";
import { resolveTransferAllowlist } from "./payment-limits.js";
import { insertSpendRecord, onchainTxInsert } from "../state/database.js";
import { walletCacheKey } from "../survival/balance.js";

type Database = BetterSqlite3.Database;

export const USDC_DECIMALS = 6;
/** Base units per cent of USDC (10^(6-2)). */
export const UNITS_PER_CENT = 10_000n;
export const RECEIPT_TIMEOUT_MS = 90_000;
export const MAX_REASON_LENGTH = 200;

/** Chain access for one transfer (viem in production, a fake in tests). */
export interface UsdcChain {
  decimals(): Promise<number>;
  usdcBalance(address: Address): Promise<bigint>;
  ethBalance(address: Address): Promise<bigint>;
  /** Estimated fee in wei for transfer(to, units) from the wallet. */
  estimateTransferFeeWei(to: Address, units: bigint): Promise<bigint>;
  /** Signs and broadcasts transfer(to, units); returns the tx hash. */
  sendTransfer(to: Address, units: bigint): Promise<`0x${string}`>;
  waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<{ status: "success" | "reverted" | "timeout"; gasUsed?: bigint; blockNumber?: bigint }>;
}

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** viem implementation on the given network (RPC: rpcUrl, else the chain default). */
export function createViemUsdcChain(account: PrivateKeyAccount, network: NetworkInfo, rpcUrl?: string): UsdcChain {
  const token = usdcAddressFor(network.caip2);
  if (!token) throw new Error(`No USDC contract known for ${network.label}.`);
  const transport = http(rpcUrl || undefined, { timeout: 15_000 });
  const pub = createPublicClient({ chain: network.chain, transport });
  const wallet = createWalletClient({ account, chain: network.chain, transport });
  return {
    decimals: async () => Number(await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" })),
    usdcBalance: (a) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [a] }),
    ethBalance: (a) => pub.getBalance({ address: a }),
    estimateTransferFeeWei: async (to, units) => {
      const [gas, price] = await Promise.all([
        pub.estimateContractGas({ address: token, abi: ERC20_ABI, functionName: "transfer", args: [to, units], account }),
        pub.getGasPrice(),
      ]);
      return gas * price;
    },
    sendTransfer: (to, units) => wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "transfer", args: [to, units], account, chain: network.chain }),
    waitForReceipt: async (hash, timeoutMs) => {
      try {
        const r = await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
        return { status: r.status === "success" ? "success" : "reverted", gasUsed: r.gasUsed, blockNumber: r.blockNumber };
      } catch (err: any) {
        if (/timed? ?out/i.test(String(err?.name ?? "") + String(err?.message ?? ""))) return { status: "timeout" };
        throw err;
      }
    },
  };
}

export type SendUsdcResult =
  | { ok: false; code: string; message: string }
  | { ok: true; status: "confirmed" | "pending"; txHash: `0x${string}`; message: string }
  | { ok: false; code: "REVERTED"; txHash: `0x${string}`; message: string };

export interface SendUsdcParams {
  db: Database;
  policy: TreasuryPolicy;
  creatorAddress: string | undefined;
  from: Address;
  to: string;
  amountCents: unknown;
  reason: unknown;
  network: NetworkInfo;
  chain: UsdcChain;
  receiptTimeoutMs?: number;
}

const usd = (cents: number) => `${(cents / 100).toFixed(2)} USDC`;
const refuse = (code: string, message: string): SendUsdcResult => ({ ok: false, code, message: `Blocked: ${message}` });

let inFlight = false;

/** Runs every check, then sends. Never throws for a refusal; returns { ok: false }. */
export async function sendUsdc(p: SendUsdcParams): Promise<SendUsdcResult> {
  const policy = p.policy;
  const amount = p.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    return refuse("INVALID_AMOUNT", `amount_cents must be a whole number of cents >= 1 (1 cent = 0.01 USDC), got ${JSON.stringify(amount)}.`);
  }
  if (amount > policy.maxSingleTransferCents) {
    return refuse("SPEND_LIMIT_EXCEEDED", `${usd(amount)} is above the per-transfer limit of ${usd(policy.maxSingleTransferCents)}.`);
  }
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  if (!reason) return refuse("REASON_REQUIRED", "a reason is required for every payment.");
  if (reason.length > MAX_REASON_LENGTH) return refuse("REASON_TOO_LONG", `the reason must be at most ${MAX_REASON_LENGTH} characters.`);

  if (typeof p.to !== "string" || !isAddress(p.to, { strict: false })) {
    return refuse("INVALID_RECIPIENT", `${JSON.stringify(p.to)} is not a valid address.`);
  }
  const to = p.to.toLowerCase() as Address;
  const allowed = resolveTransferAllowlist(policy, p.creatorAddress);
  if (allowed.length === 0) return refuse("PAYMENTS_OFF", "the owner has not allowed payments to anyone (transferAllowlist is empty).");
  if (to === p.from.toLowerCase()) return refuse("SELF_TRANSFER", "cannot send to your own wallet.");
  if (!allowed.includes(to)) return refuse("RECIPIENT_NOT_ALLOWED", `${to} is not on the owner's recipient list. Don't retry.`);

  const window = new SpendTracker(p.db).checkLimit(amount, "transfer", policy);
  if (!window.allowed) {
    return refuse("SPEND_LIMIT_EXCEEDED", `${window.reason?.startsWith("Hourly") ? "hourly" : "daily"} payment limit: ` +
      `${usd(window.reason?.startsWith("Hourly") ? window.currentHourlySpend : window.currentDailySpend)} already sent, limit ` +
      `${usd(window.reason?.startsWith("Hourly") ? window.limitHourly : window.limitDaily)}.`);
  }

  if (inFlight) return refuse("TRANSFER_IN_PROGRESS", "another payment is still being sent; try again later.");
  inFlight = true;
  try {
    let decimals: number;
    let usdc: bigint;
    let eth: bigint;
    let fee: bigint;
    const units = BigInt(amount) * UNITS_PER_CENT;
    try {
      decimals = await p.chain.decimals();
      if (decimals !== USDC_DECIMALS) return refuse("TOKEN_DECIMALS", `the USDC contract reports ${decimals} decimals, expected ${USDC_DECIMALS}.`);
      [usdc, eth] = await Promise.all([p.chain.usdcBalance(p.from), p.chain.ethBalance(p.from)]);
    } catch (err: any) {
      return refuse("CHAIN_UNREACHABLE", `could not read balances on ${p.network.label} (${err?.message ?? err}); nothing was sent.`);
    }
    const needed = units + BigInt(policy.minimumReserveCents) * UNITS_PER_CENT;
    if (usdc < needed) {
      return refuse("RESERVE", `wallet has ${usd(Number(usdc / UNITS_PER_CENT))}; sending ${usd(amount)} would leave less than the ` +
        `${usd(policy.minimumReserveCents)} reserve.`);
    }
    try {
      fee = await p.chain.estimateTransferFeeWei(to, units);
    } catch (err: any) {
      return refuse("CHAIN_UNREACHABLE", `could not estimate the network fee (${err?.message ?? err}); nothing was sent.`);
    }
    if (eth < fee * 2n) return refuse("NO_GAS", `not enough ETH on ${p.network.label} for the network fee; nothing was sent.`);

    // Reserve the spend before broadcasting.
    const spendId = ulid();
    const now = new Date().toISOString();
    insertSpendRecord(p.db, {
      id: spendId, toolName: "send_usdc", amountCents: amount, recipient: to, domain: null, category: "transfer",
      windowHour: now.slice(0, 13), windowDay: now.slice(0, 10),
    });
    const release = () => p.db.prepare("DELETE FROM spend_tracking WHERE id = ?").run(spendId);

    let hash: `0x${string}`;
    try {
      hash = await p.chain.sendTransfer(to, units);
    } catch (err: any) {
      release();
      return refuse("SEND_FAILED", `the transaction was not sent (${err?.message ?? err}).`);
    }
    const meta = { to, amountCents: amount, reason, network: p.network.caip2, token: usdcAddressFor(p.network.caip2), spendId };
    onchainTxInsert(p.db, {
      id: ulid(), txHash: hash, chain: p.network.caip2, operation: "usdc_transfer", status: "pending",
      gasUsed: null, metadata: JSON.stringify(meta), createdAt: now,
    });

    let receipt: Awaited<ReturnType<UsdcChain["waitForReceipt"]>>;
    try {
      receipt = await p.chain.waitForReceipt(hash, p.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS);
    } catch {
      receipt = { status: "timeout" };
    }
    const setStatus = (s: "confirmed" | "failed") =>
      p.db.prepare("UPDATE onchain_transactions SET status = ?, gas_used = ? WHERE tx_hash = ?")
        .run(s, receipt.gasUsed !== undefined ? Number(receipt.gasUsed) : null, hash);
    // Fork (Phase 4): refresh the cached wallet balance right after the payment.
    await refreshWalletCache(p, receipt.status === "timeout");
    if (receipt.status === "success") {
      setStatus("confirmed");
      return { ok: true, status: "confirmed", txHash: hash, message: `Sent ${usd(amount)} to ${to} on ${p.network.label} (tx ${hash}, block ${receipt.blockNumber ?? "?"}).` };
    }
    if (receipt.status === "reverted") {
      setStatus("failed");
      release();
      return { ok: false, code: "REVERTED", txHash: hash, message: `The payment failed on chain (tx ${hash} reverted); no USDC moved.` };
    }
    return { ok: true, status: "pending", txHash: hash, message: `Payment of ${usd(amount)} to ${to} was sent (tx ${hash}) but is not confirmed yet; it counts against the limits. Do not send it again.` };
  } finally {
    inFlight = false;
  }
}

/**
 * Fork (Phase 4): after a broadcast, the cached wallet balance
 * (walletReadCacheSeconds; also read by the reserve rule) must not keep the
 * pre-payment figure. Confirmed or reverted: write a fresh on-chain read.
 * Pending, or the read fails: delete the cache entry, so the next balance read
 * goes on chain and the reserve rule fails closed until then.
 */
async function refreshWalletCache(p: SendUsdcParams, pending: boolean): Promise<void> {
  const key = walletCacheKey(p.network.caip2, p.from);
  const drop = () => p.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  if (pending) {
    drop();
    return;
  }
  try {
    const units = await p.chain.usdcBalance(p.from);
    p.db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, JSON.stringify({ usdc: Number(units) / 1_000_000, at: new Date().toISOString() }));
  } catch {
    drop();
  }
}

/**
 * The send_usdc tool body: active network, the owner's treasury policy and
 * creator from the config, the runtime's wallet. `chain` is injected by the
 * owner's payment test (and unit tests); otherwise a viem client is built.
 */
export async function executeSendUsdc(
  args: Record<string, unknown>,
  ctx: ToolContext,
  chain?: UsdcChain,
): Promise<SendUsdcResult> {
  if ((ctx.identity.chainType ?? "evm") !== "evm") return refuse("EVM_ONLY", "send_usdc supports EVM wallets only.");
  const network = getActiveNetwork();
  let c = chain;
  if (!c) {
    try {
      c = createViemUsdcChain(ctx.identity.account, network, ctx.config.rpcUrl || process.env.AUTOMATON_RPC_URL);
    } catch (err: any) {
      return refuse("NO_USDC", String(err?.message ?? err));
    }
  }
  return sendUsdc({
    db: ctx.db.raw,
    policy: ctx.config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    creatorAddress: ctx.config.creatorAddress,
    from: ctx.identity.address as Address,
    to: args.to_address as string,
    amountCents: args.amount_cents,
    reason: args.reason,
    network,
    chain: c,
  });
}

/** Tests only. */
export function resetUsdcTransferStateForTests(): void {
  inFlight = false;
}
