/**
 * Owner `--wallet send` (fork, Phase 4 step 7) and the tier-walk template.
 * Owner requirements: pays only the creator, through the same send_usdc checks
 * and the active template's limits; prints project, wallet, amount and balance
 * after; dry run without --confirm; each send recorded and logged like an agent
 * payment (no ledger entry: owner decision 2026-11-23, the wallet is read on chain).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseOwnerSendArgs, runOwnerSend, type OwnerSendDeps } from "../agent/owner-send.js";
import { resetUsdcTransferStateForTests, UNITS_PER_CENT, type UsdcChain } from "../agent/usdc-transfer.js";
import { NETWORKS, resetNetworkForTests } from "../identity/network.js";
import { createBuiltinTools } from "../agent/tools.js";
import { checkPaymentLimits, looserThanDefaults } from "../agent/payment-limits.js";
import { checkSurvivalSettings, resolveSurvivalSettings } from "../survival/settings.js";
import { getSurvivalTier } from "../conway/credits.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase, type ToolContext, type TreasuryPolicy } from "../types.js";

const WALLET = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";
const REPO = path.join(__dirname, "..", "..");
const tierwalk = JSON.parse(fs.readFileSync(path.join(REPO, "docker", "automaton.tierwalk.json"), "utf-8"));
const WALK_POLICY: TreasuryPolicy = { ...DEFAULT_TREASURY_POLICY, ...tierwalk.treasuryPolicy };
const WALK_SURVIVAL = resolveSurvivalSettings(tierwalk);

let n = 0; // tx hashes unique across fake chains
function chain(startCents: number) {
  let cents = startCents;
  const sent: { to: string; units: bigint }[] = [];
  const c: UsdcChain = {
    decimals: async () => 6,
    usdcBalance: async () => BigInt(cents) * UNITS_PER_CENT,
    ethBalance: async () => 5n * 10n ** 14n,
    estimateTransferFeeWei: async () => 10n ** 11n,
    sendTransfer: async (to, units) => { sent.push({ to, units }); cents -= Number(units / UNITS_PER_CENT); return `0x${(++n).toString(16).padStart(64, "0")}`; },
    waitForReceipt: async () => ({ status: "success", gasUsed: 45_000n, blockNumber: 9n }),
  };
  return { chain: c, sent };
}

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); resetNetworkForTests(); resetUsdcTransferStateForTests(); });
afterEach(() => db.close());

function deps(c: UsdcChain, over: Partial<{ policy: TreasuryPolicy; creator: string; project: string | null }> = {}): OwnerSendDeps {
  const policy = over.policy ?? WALK_POLICY;
  const ctx = {
    identity: { address: WALLET, chainType: "evm", account: {} },
    config: { creatorAddress: over.creator ?? CREATOR, treasuryPolicy: policy },
    db,
  } as unknown as ToolContext;
  return {
    db: db.raw, ctx, sendTool: createBuiltinTools("").find((t) => t.name === "send_usdc")!, network: NETWORKS.testnet,
    chain: c, policy, survival: WALK_SURVIVAL, project: over.project === undefined ? "automaton-tierwalk" : over.project,
  };
}
const rows = (t: string) => db.raw.prepare(`SELECT * FROM ${t}`).all() as any[];

describe("arguments: the creator only", () => {
  it("parses cents, all, --confirm and --reason", () => {
    expect(parseOwnerSendArgs(["15"])).toEqual({ amount: 15, confirm: false, reason: "owner wallet send" });
    expect(parseOwnerSendArgs(["all", "--confirm", "--reason", "tier walk: critical"])).toEqual({ amount: "all", confirm: true, reason: "tier walk: critical" });
  });

  it("refuses any recipient: an address, --to, or unknown arguments", () => {
    expect((parseOwnerSendArgs(["15", OTHER]) as any).error).toMatch(/pays only the creator address/);
    expect((parseOwnerSendArgs(["15", "--to", OTHER]) as any).error).toMatch(/pays only the creator address/);
    expect((parseOwnerSendArgs([OTHER, "15"]) as any).error).toMatch(/pays only the creator address/);
    expect((parseOwnerSendArgs(["15", "--recipient"]) as any).error).toMatch(/Unknown argument/);
    expect((parseOwnerSendArgs([]) as any).error).toMatch(/No amount/);
    expect((parseOwnerSendArgs(["0"]) as any).error).toMatch(/at least 1 cent/);
    expect((parseOwnerSendArgs(["1.5"]) as any).error).toMatch(/Unknown argument/);
    expect((parseOwnerSendArgs(["15", "--reason"]) as any).error).toMatch(/--reason needs a text/);
  });
});

describe("dry run (no --confirm)", () => {
  it("prints project, wallet, recipient, amount, balance after and tiers; signs and records nothing", async () => {
    const { chain: c, sent } = chain(50);
    const r = await runOwnerSend(deps(c), { amount: 15, confirm: false, reason: "tier walk: normal" });
    expect(r.code).toBe(0);
    expect(r.output).toContain("DRY RUN (add --confirm to send)");
    expect(r.output).toContain("Project:          automaton-tierwalk");
    expect(r.output).toContain(`Agent wallet:     ${WALLET}`);
    expect(r.output).toContain(`To (creator):     ${CREATOR}`);
    expect(r.output).toContain("Amount:           0.15 USDC");
    expect(r.output).toContain("Wallet USDC:      0.50 USDC → 0.35 USDC after");
    expect(r.output).toContain("Survival balance: $0.50 (high) → $0.35 (normal) after");
    expect(r.output).toMatch(/Dry run: all checks passed .* Run again with --confirm to send\./);
    expect(sent).toEqual([]);
    expect(rows("onchain_transactions")).toEqual([]);
    expect(rows("spend_tracking")).toEqual([]);
    expect(rows("policy_decisions")).toEqual([]);
  });

  it("a refusal is shown in the dry run too (above the per-transfer limit)", async () => {
    const { chain: c, sent } = chain(50);
    const r = await runOwnerSend(deps(c), { amount: 26, confirm: false, reason: "x" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/REFUSED by policy: SPEND_LIMIT_EXCEEDED/);
    expect(sent).toEqual([]);
  });

  it("no project known: says so", async () => {
    const { chain: c } = chain(50);
    expect((await runOwnerSend(deps(c, { project: null }), { amount: 5, confirm: false, reason: "x" })).output)
      .toContain("Project:          (unknown: not started through run-oneoff)");
  });
});

describe("--confirm: sent like an agent payment, to the creator only", () => {
  it("sends to the creator; recorded in onchain_transactions (initiator owner), spend_tracking and policy_decisions; no ledger entry", async () => {
    const { chain: c, sent } = chain(50);
    const r = await runOwnerSend(deps(c), { amount: 15, confirm: true, reason: "tier walk: normal" });
    expect(r.code).toBe(0);
    expect(r.output).toContain("CONFIRMED");
    expect(r.output).toMatch(/RESULT: Sent 0\.15 USDC to 0x1111111111111111111111111111111111111111 on Base Sepolia/);
    expect(sent).toEqual([{ to: CREATOR, units: 150_000n }]);
    const tx = rows("onchain_transactions");
    expect(tx).toHaveLength(1);
    expect(JSON.parse(tx[0].metadata)).toMatchObject({ initiator: "owner", amountCents: 15, to: CREATOR, reason: "tier walk: normal" });
    expect(rows("spend_tracking")).toMatchObject([{ tool_name: "send_usdc", amount_cents: 15, category: "transfer" }]);
    expect(rows("policy_decisions")).toMatchObject([{ tool_name: "send_usdc", decision: "allow" }]);
    expect(rows("ledger_entries")).toEqual([]);
  });

  it("logged like an agent payment: one INFO line 'USDC payment (owner): …' (agent payments: '(agent)')", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: any) => { out.push(String(s)); return true; }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(((s: any) => { out.push(String(s)); return true; }) as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    try {
      const { chain: c } = chain(50);
      await runOwnerSend(deps(c), { amount: 15, confirm: true, reason: "tier walk: normal" });
      const { executeSendUsdc } = await import("../agent/usdc-transfer.js");
      const { chain: c2 } = chain(50);
      await executeSendUsdc({ to_address: CREATOR, amount_cents: 5, reason: "agent" }, deps(c2).ctx, c2);
    } finally {
      spy.mockRestore();
      spyErr.mockRestore();
      logSpy.mockRestore();
    }
    const lines = out.join("\n");
    expect(lines).toMatch(/USDC payment \(owner\): 0\.15 USDC to 0x1111111111111111111111111111111111111111 on Base Sepolia \(testnet\), confirmed, tx 0x[0-9a-f]{64}; reason: tier walk: normal/);
    expect(lines).toMatch(/USDC payment \(agent\): 0\.05 USDC to 0x1111111111111111111111111111111111111111 .*confirmed/);
  });

  it("'all' sends the whole wallet (the last drain step)", async () => {
    const { chain: c, sent } = chain(8);
    const r = await runOwnerSend(deps(c), { amount: "all", confirm: true, reason: "tier walk: dead" });
    expect(r.output).toContain("Amount:           0.08 USDC (all)");
    expect(sent).toEqual([{ to: CREATOR, units: 80_000n }]);
  });

  it("the template's limits apply: the main template's $1 reserve refuses what the walk allows", async () => {
    const main = JSON.parse(fs.readFileSync(path.join(REPO, "docker", "automaton.testnet.json"), "utf-8"));
    const { chain: c, sent } = chain(50);
    const r = await runOwnerSend(deps(c, { policy: { ...DEFAULT_TREASURY_POLICY, ...main.treasuryPolicy } }), { amount: 15, confirm: true, reason: "x" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/REFUSED: Policy denied: RESERVE/);
    expect(sent).toEqual([]);
  });

  it("the creator must be on the template's recipient list (an empty list refuses)", async () => {
    const { chain: c, sent } = chain(50);
    const r = await runOwnerSend(deps(c, { policy: { ...WALK_POLICY, transferAllowlist: [] } }), { amount: 5, confirm: true, reason: "x" });
    expect(r.output).toMatch(/REFUSED: Policy denied: PAYMENTS_OFF/);
    expect(sent).toEqual([]);
  });

  it("the hourly window counts earlier owner sends (60¢ in the walk template)", async () => {
    const { chain: c, sent } = chain(100);
    for (const amount of [25, 25]) expect((await runOwnerSend(deps(c), { amount, confirm: true, reason: "x" })).code).toBe(0);
    const third = await runOwnerSend(deps(c), { amount: 11, confirm: true, reason: "x" });
    expect(third.output).toMatch(/REFUSED: Policy denied: SPEND_LIMIT_EXCEEDED/);
    expect(sent).toHaveLength(2);
  });
});

describe("the tier-walk template", () => {
  it("is valid: limits, survival settings; reserve $0; the agent cannot pay (no send_usdc)", () => {
    expect(checkPaymentLimits(WALK_POLICY)).toEqual([]);
    expect(checkSurvivalSettings(tierwalk)).toEqual([]);
    expect(WALK_POLICY).toMatchObject({ maxSingleTransferCents: 25, maxHourlyTransferCents: 60, maxDailyTransferCents: 100, minimumReserveCents: 0, transferAllowlist: ["creator"] });
    expect(WALK_SURVIVAL).toEqual({ highCents: 40, normalCents: 30, lowComputeCents: 15, deadGraceMinutes: 5, tierWakeMinGapMinutes: 1 });
    expect(tierwalk.toolAllowlist).toEqual(["check_balance", "sleep"]);
    expect(looserThanDefaults(WALK_POLICY)).toEqual(["minimumReserveCents 0 < default 1000"]);
  });

  it("the drain plan lands inside each tier with up to 4¢ of inference cost (and none)", () => {
    // Funded 0.50 USDC, ledger $0 at start; inference makes the ledger negative.
    const plan: [string, number, string][] = [
      ["start", 0, "high"], ["drain 1", 15, "normal"], ["drain 2", 13, "low_compute"], ["drain 3", 14, "critical"],
    ];
    for (const inference of [0, 1, 2, 3, 4]) {
      let wallet = 50;
      for (const [step, send, expected] of plan) {
        wallet -= send;
        const total = wallet - inference;
        expect(getSurvivalTier(total, WALK_SURVIVAL), `${step} with ${inference}¢ inference: $${total / 100}`).toBe(expected);
      }
      // drain 4: "all" empties the wallet; the total is the ledger: below $0 (dead at once) or $0 (dead after 5 min)
      const total = 0 - inference;
      expect(["dead", "critical"]).toContain(getSurvivalTier(total, WALK_SURVIVAL));
      // revive: 0.25 USDC from MetaMask (owner, 2026-11-23) → above $0 → low_compute, clear of both boundaries
      expect(getSurvivalTier(25 - inference, WALK_SURVIVAL)).toBe("low_compute");
      expect(25 - inference - WALK_SURVIVAL.lowComputeCents).toBeGreaterThanOrEqual(6);
    }
  });
});
