/**
 * Owner payment-limits test (fork, Phase 3 step 7), against a stateful fake
 * chain: the same flow `pnpm agent:payment-test` runs on Base Sepolia.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runPaymentTest, paymentTestPreconditions, formatPaymentTest, TEST_AMOUNT_CENTS } from "../agent/payment-test.js";
import { resetUsdcTransferStateForTests, UNITS_PER_CENT, type UsdcChain } from "../agent/usdc-transfer.js";
import { NETWORKS, resetNetworkForTests } from "../identity/network.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase, type ToolContext, type TreasuryPolicy } from "../types.js";

const WALLET = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x1111111111111111111111111111111111111111";
const POLICY: TreasuryPolicy = {
  ...DEFAULT_TREASURY_POLICY,
  maxSingleTransferCents: 25, maxHourlyTransferCents: 50, maxDailyTransferCents: 100,
  minimumReserveCents: 100, maxTransfersPerTurn: 1, requireConfirmationAboveCents: 25, transferAllowlist: ["creator"],
};

function statefulChain(startCents: number, opts: { ethWei?: bigint } = {}) {
  let cents = startCents;
  const sent: { to: string; units: bigint }[] = [];
  const chain: UsdcChain = {
    decimals: async () => 6,
    usdcBalance: async () => BigInt(cents) * UNITS_PER_CENT,
    ethBalance: async () => opts.ethWei ?? 5n * 10n ** 14n,
    estimateTransferFeeWei: async () => 10n ** 11n,
    sendTransfer: async (to, units) => {
      sent.push({ to, units });
      cents -= Number(units / UNITS_PER_CENT);
      return `0x${sent.length.toString(16).padStart(64, "0")}`;
    },
    waitForReceipt: async () => ({ status: "success", gasUsed: 40_000n, blockNumber: 1n }),
  };
  return { chain, sent };
}

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); resetNetworkForTests(); resetUsdcTransferStateForTests(); });
afterEach(() => db.close());

function deps(chain: UsdcChain, over: { policy?: TreasuryPolicy; creator?: string; network?: typeof NETWORKS.testnet } = {}) {
  const policy = over.policy ?? POLICY;
  const ctx = {
    identity: { address: WALLET, chainType: "evm", account: {} },
    config: { creatorAddress: over.creator ?? CREATOR, treasuryPolicy: policy },
    db,
  } as unknown as ToolContext;
  return { db: db.raw, ctx, sendTool: createBuiltinTools("").find((t) => t.name === "send_usdc")!, network: over.network ?? NETWORKS.testnet, chain, policy };
}

describe("payment test", () => {
  it("2.00 USDC wallet: one real transfer to the creator, every limit refused, nothing else signed", async () => {
    const { chain, sent } = statefulChain(200);
    const d = deps(chain);
    expect(await paymentTestPreconditions(d)).toEqual([]);
    const r = await runPaymentTest(d);
    const text = formatPaymentTest(r);
    expect(r.ok, text).toBe(true);
    expect(sent).toEqual([{ to: CREATOR, units: BigInt(TEST_AMOUNT_CENTS) * UNITS_PER_CENT }]);
    expect(r.cases.map((c) => c.name)).toEqual([
      "inside the limits: 0.10 USDC to the creator",
      "per-transfer limit: 26 cents",
      "recipient not on the list",
      "second transfer in the same turn",
      "hourly limit (tightened to the 10 cents already sent this hour)",
      "daily limit (tightened to the 10 cents already sent today)",
      "reserve (raised to the current balance, 190 cents)",
      "tool layer alone: recipient not on the list",
      "tool layer alone: per-transfer limit",
    ]);
    const detail = (i: number) => r.cases[i].detail;
    expect(detail(0)).toMatch(/^Sent 0.10 USDC/);
    expect(detail(1)).toMatch(/^Policy denied: SPEND_LIMIT_EXCEEDED/);
    expect(detail(2)).toMatch(/^Policy denied: RECIPIENT_NOT_ALLOWED/);
    expect(detail(3)).toMatch(/^Policy denied: TURN_TRANSFER_LIMIT/);
    expect(detail(4)).toMatch(/^Policy denied: SPEND_LIMIT_EXCEEDED — Transfer would exceed hourly cap/);
    expect(detail(5)).toMatch(/^Policy denied: SPEND_LIMIT_EXCEEDED — Transfer would exceed daily cap/);
    expect(detail(6)).toMatch(/^Policy denied: RESERVE/);
    expect(detail(7)).toMatch(/^Blocked: .* not on the owner's recipient list/);
    expect(detail(8)).toMatch(/^Blocked: .*above the per-transfer limit/);
    expect(text).toContain("=== PAYMENT TEST PASSED ===");
    // exactly one transaction and one spend row
    expect((db.raw.prepare("SELECT COUNT(*) c FROM onchain_transactions").get() as any).c).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) c FROM spend_tracking").get() as any).c).toBe(1);
  });

  it("a refusal that still signs is reported as FAIL", async () => {
    // A broken policy that allows the not-listed recipient at both layers: the run must fail.
    const { chain, sent } = statefulChain(200);
    const broken = { ...POLICY, transferAllowlist: ["creator", "0x000000000000000000000000000000000000dEaD"] };
    const r = await runPaymentTest(deps(chain, { policy: broken }));
    expect(r.ok).toBe(false);
    expect(r.cases.find((c) => c.name === "recipient not on the list")?.ok).toBe(false);
    expect(sent.length).toBeGreaterThan(1);
  });

  it("preconditions: testnet only, creator on the list, amount + reserve, ETH", async () => {
    const { chain } = statefulChain(105, { ethWei: 0n });
    const p = await paymentTestPreconditions(deps(chain, { network: NETWORKS.mainnet, policy: { ...POLICY, transferAllowlist: [] } }));
    expect(p.join("\n")).toMatch(/testnet only/);
    expect(p.join("\n")).toMatch(/creator address is not on treasuryPolicy.transferAllowlist/);
    expect(p.join("\n")).toMatch(/wallet has 1.05 USDC; the test needs 1.10/);
    expect(p.join("\n")).toMatch(/no ETH/);
  });
});
