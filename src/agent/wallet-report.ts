/**
 * Owner wallet report (fork, Phase 3 step 5): `pnpm agent:wallet`.
 *
 * Address and encryption state, live USDC and ETH balances on the active
 * network (read-only RPC calls; nothing is signed), the payment limits, what
 * was sent this UTC hour and today, and the most recent send_usdc transfers.
 * Never prints key material.
 */

import { createPublicClient, formatEther, http, type Address } from "viem";
import type BetterSqlite3 from "better-sqlite3";
import type { TreasuryPolicy } from "../types.js";
import type { NetworkInfo } from "../identity/network.js";
import type { WalletInfo } from "../identity/wallet.js";
import { usdcAddressFor } from "../conway/x402.js";
import { describePaymentLimits } from "./payment-limits.js";
import { SpendTracker } from "./spend-tracker.js";

type Database = BetterSqlite3.Database;

export interface WalletBalances {
  usdcUnits: bigint | null;
  ethWei: bigint | null;
  error?: string;
}

const BALANCE_OF_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Live balances; null (with error) when the RPC cannot be reached. */
export async function readWalletBalances(address: Address, network: NetworkInfo, rpcUrl?: string): Promise<WalletBalances> {
  const token = usdcAddressFor(network.caip2);
  const pub = createPublicClient({ chain: network.chain, transport: http(rpcUrl || undefined, { timeout: 10_000 }) });
  const [usdc, eth] = await Promise.allSettled([
    token ? pub.readContract({ address: token, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [address] }) : Promise.reject(new Error("no USDC contract")),
    pub.getBalance({ address }),
  ]);
  const err = [usdc, eth].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  return {
    usdcUnits: usdc.status === "fulfilled" ? usdc.value : null,
    ethWei: eth.status === "fulfilled" ? eth.value : null,
    error: err ? String(err.reason?.shortMessage ?? err.reason?.message ?? err.reason) : undefined,
  };
}

const usdcText = (units: bigint) => `${(Number(units / 100n) / 10_000).toFixed(2)} USDC`;
const centsText = (cents: number) => `${(cents / 100).toFixed(2)} USDC`;

export function walletReport(o: {
  info: WalletInfo;
  network: NetworkInfo | null;
  networkError?: string;
  balances: WalletBalances | null;
  policy: TreasuryPolicy;
  creatorAddress: string | undefined;
  encryptionSetting: string;
  db: Database | null;
}): string {
  const lines = ["=== WALLET ==="];
  if (!o.info.exists) {
    lines.push("No wallet.");
  } else {
    lines.push(`Address:    ${o.info.address}`);
    lines.push(`Chain:      ${o.info.chainType}`);
    lines.push(`Created:    ${o.info.createdAt ?? "?"}`);
    lines.push(`Encrypted:  ${o.info.encrypted ? `yes (${o.info.kdf})` : "NO (plaintext key in wallet.json)"}`);
    lines.push(`Network:    ${o.network ? o.network.label : `unknown (${o.networkError ?? "not activated"})`}`);
    const b = o.balances;
    if (b) {
      lines.push(`USDC:       ${b.usdcUnits === null ? `unavailable (${b.error ?? "RPC error"})` : usdcText(b.usdcUnits)}`);
      lines.push(`ETH:        ${b.ethWei === null ? `unavailable (${b.error ?? "RPC error"})` : `${Number(formatEther(b.ethWei)).toFixed(6)} ETH (network fees)`}`);
    }
  }
  lines.push(`Payments:   ${describePaymentLimits(o.policy, o.creatorAddress)}`);
  if (o.db) {
    const t = new SpendTracker(o.db);
    lines.push(`Sent:       ${centsText(t.getHourlySpend("transfer"))} this UTC hour, ${centsText(t.getDailySpend("transfer"))} today (UTC)`);
    const rows = o.db.prepare(
      "SELECT tx_hash, status, metadata, created_at FROM onchain_transactions WHERE operation = 'usdc_transfer' ORDER BY created_at DESC LIMIT 5",
    ).all() as { tx_hash: string; status: string; metadata: string; created_at: string }[];
    lines.push(`Recent transfers:${rows.length ? "" : " none"}`);
    for (const r of rows) {
      let m: { to?: string; amountCents?: number; reason?: string } = {};
      try { m = JSON.parse(r.metadata); } catch { /* keep empty */ }
      lines.push(`  ${r.created_at}  ${typeof m.amountCents === "number" ? centsText(m.amountCents) : "?"} → ${m.to ?? "?"}  ${r.status}  ${r.tx_hash}`);
    }
  }
  lines.push(`Setting:    walletEncryption ${o.encryptionSetting}`);
  return lines.join("\n");
}
