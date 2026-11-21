/**
 * Policy rules for send_usdc and the enforced minimum reserve (fork, Phase 3
 * step 4, owner-approved under rule 4, tightening only).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFinancialRules, TRANSFER_TOOLS } from "../agent/policy-rules/financial.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createBuiltinTools } from "../agent/tools.js";
import { resetNetworkForTests } from "../identity/network.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase, type PolicyRequest, type ToolContext, type TreasuryPolicy } from "../types.js";

const WALLET = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x000000000000000000000000000000000000dEaD";
const STRANGER = "0x3333333333333333333333333333333333333333";
const POLICY: TreasuryPolicy = {
  ...DEFAULT_TREASURY_POLICY,
  maxSingleTransferCents: 25, maxHourlyTransferCents: 50, maxDailyTransferCents: 100,
  minimumReserveCents: 100, maxTransfersPerTurn: 1, requireConfirmationAboveCents: 25, transferAllowlist: ["creator"],
};
const sendTool = createBuiltinTools("").find((t) => t.name === "send_usdc")!;

let db: AutomatonDatabase;
let engine: PolicyEngine;

function cacheWallet(usdc: number): void {
  db.raw.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
    .run(`wallet_usdc_cache:eip155:84532:${WALLET}`, JSON.stringify({ usdc, at: new Date().toISOString() }));
}

function request(args: Record<string, unknown>, turnToolCallCount = 0, policy = POLICY): PolicyRequest {
  return {
    tool: sendTool,
    args: { to_address: CREATOR, amount_cents: 10, reason: "test", ...args },
    context: { identity: { address: WALLET }, config: { creatorAddress: CREATOR, treasuryPolicy: policy }, db } as unknown as ToolContext,
    turnContext: { inputSource: "agent", turnToolCallCount, sessionSpend: new SpendTracker(db.raw) },
  };
}

beforeEach(() => {
  resetNetworkForTests();
  db = createTestDb();
  engine = new PolicyEngine(db.raw, createFinancialRules(POLICY));
  cacheWallet(5); // 500 cents
});
afterEach(() => db.close());

describe("send_usdc policy rules", () => {
  it("allows a payment within every limit to the creator", () => {
    expect(engine.evaluate(request({})).action).toBe("allow");
  });

  it("denies a recipient that is not on the list, and every payment when the list is empty", () => {
    const d = engine.evaluate(request({ to_address: STRANGER }));
    expect(d).toMatchObject({ action: "deny", reasonCode: "RECIPIENT_NOT_ALLOWED" });
    const off = new PolicyEngine(db.raw, createFinancialRules({ ...POLICY, transferAllowlist: [] }));
    expect(off.evaluate(request({}, 0, { ...POLICY, transferAllowlist: [] }))).toMatchObject({ action: "deny", reasonCode: "PAYMENTS_OFF" });
  });

  it("denies above the per-transfer limit", () => {
    expect(engine.evaluate(request({ amount_cents: 26 }))).toMatchObject({ action: "deny", reasonCode: "SPEND_LIMIT_EXCEEDED" });
  });

  it("denies when the hourly window is used up", () => {
    new SpendTracker(db.raw).recordSpend({ toolName: "send_usdc", amountCents: 45, category: "transfer" });
    expect(engine.evaluate(request({ amount_cents: 10 }))).toMatchObject({ action: "deny", reasonCode: "SPEND_LIMIT_EXCEEDED" });
  });

  it("denies a second transfer in the same turn", () => {
    expect(engine.evaluate(request({}, 1))).toMatchObject({ action: "deny", reasonCode: "TURN_TRANSFER_LIMIT" });
  });

  it("enforces the minimum reserve against the cached wallet balance", () => {
    cacheWallet(1.2); // 120 cents
    expect(engine.evaluate(request({ amount_cents: 20 })).action).toBe("allow"); // leaves exactly 100
    expect(engine.evaluate(request({ amount_cents: 21 }))).toMatchObject({ action: "deny", reasonCode: "RESERVE" });
  });

  it("denies when no wallet balance has been read yet (fail closed)", () => {
    db.raw.prepare("DELETE FROM kv WHERE key LIKE 'wallet_usdc_cache:%'").run();
    expect(engine.evaluate(request({}))).toMatchObject({ action: "deny", reasonCode: "RESERVE_UNKNOWN" });
  });

  it("a denial can be recorded in policy_decisions (executeTool logs every decision; the watchdog counts them)", () => {
    engine.logDecision(engine.evaluate(request({ to_address: STRANGER })));
    const row = db.raw.prepare("SELECT tool_name, decision FROM policy_decisions ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(row).toEqual({ tool_name: "send_usdc", decision: "deny" });
  });

  it("the default rule set includes the send_usdc rules", () => {
    const ids = createDefaultRules(POLICY).filter((r) => r.appliesTo.by === "name" && r.appliesTo.names.includes("send_usdc")).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([
      "financial.transfer_max_single", "financial.transfer_hourly_cap", "financial.transfer_daily_cap",
      "financial.minimum_reserve", "financial.transfer_recipient_allowlist", "financial.turn_transfer_limit",
      "financial.require_confirmation",
    ]));
    expect(TRANSFER_TOOLS).toEqual(["transfer_credits", "send_usdc"]);
  });

  it("through executeTool, a denied payment never reaches the tool (nothing signed)", async () => {
    const { executeTool } = await import("../agent/tools.js");
    let executed = false;
    const tool = { ...sendTool, execute: async () => { executed = true; return "sent"; } };
    const r = request({ to_address: STRANGER });
    const result = await executeTool("send_usdc", r.args, [tool], r.context, new PolicyEngine(db.raw, createDefaultRules(POLICY)), r.turnContext);
    expect(executed).toBe(false);
    expect(`${result.error ?? ""}${result.result}`).toMatch(/RECIPIENT_NOT_ALLOWED|not on the owner's recipient list/);
  });

  it("transfer_credits keeps the upstream reserve behaviour (no cache lookup)", () => {
    const tc = { ...request({}), tool: { ...sendTool, name: "transfer_credits" } };
    db.raw.prepare("DELETE FROM kv WHERE key LIKE 'wallet_usdc_cache:%'").run();
    expect(engine.evaluate(tc).action).toBe("allow");
  });
});
