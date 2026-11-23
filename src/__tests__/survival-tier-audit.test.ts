/**
 * Phase 4 step 1: characterization of the survival tiers (the tier table in
 * docs/ROADMAP.md "Phase 4"). The "TODAY:" tests of step 1 were flipped in
 * step 3 to the new behaviour ("NOW (step 3):"): no distress wakes on pings,
 * dead handled by the survival watch on every tick, no model call in dead,
 * low_compute agent turns on gpt-4.1-nano (F5). Details: survival-tier-watch.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSurvivalTier } from "../conway/credits.js";
import { SURVIVAL_THRESHOLDS, DEFAULT_MODEL_STRATEGY_CONFIG, type AutomatonDatabase, type TickContext, type HeartbeatLegacyContext } from "../types.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { waitForSleepOrWake } from "../agent/startup-sleep.js";
import { insertWakeEvent } from "../state/database.js";
import { runAgentLoop } from "../agent/loop.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity, noToolResponse } from "./mocks.js";

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("tier thresholds (hardcoded today: SURVIVAL_THRESHOLDS)", () => {
  it("$5 / $0.50 / $0.10 / >= 0, negative = dead; boundaries are exclusive above", () => {
    expect(SURVIVAL_THRESHOLDS).toMatchObject({ high: 500, normal: 50, low_compute: 10, critical: 0 });
    const cases: [number, string][] = [
      [501, "high"], [500, "normal"], [51, "normal"], [50, "low_compute"], [11, "low_compute"],
      [10, "critical"], [0, "critical"], [-1, "dead"],
    ];
    for (const [cents, tier] of cases) expect(getSurvivalTier(cents), `${cents} cents`).toBe(tier);
  });
});

describe("model routing per tier (agent_turn, default registry and strategy)", () => {
  it("NOW (step 3, F5): high/normal → gpt-4.1-mini, low_compute/critical → gpt-4.1-nano, dead → none (no model call)", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG));
    const pick = (t: Parameters<typeof router.selectModel>[0]) => router.selectModel(t, "agent_turn")?.modelId ?? null;
    expect(pick("high")).toBe("gpt-4.1-mini");
    expect(pick("normal")).toBe("gpt-4.1-mini");
    expect(pick("low_compute")).toBe("gpt-4.1-nano");
    expect(pick("critical")).toBe("gpt-4.1-nano");
    expect(pick("dead")).toBeNull();
  });
});

function tick(tier: string, creditBalance: number): TickContext {
  return { creditBalance, survivalTier: tier, balanceStatus: "live", usdcBalance: 0 } as unknown as TickContext;
}
function legacy(): HeartbeatLegacyContext {
  return { identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), db, conway: new MockConwayClient() } as HeartbeatLegacyContext;
}

describe("heartbeat in low tiers", () => {
  it("NOW (step 3, F2): heartbeat_ping never asks for a wake; it still records the distress signal", async () => {
    for (const tier of ["high", "normal", "low_compute", "critical", "dead"]) {
      const r = await BUILTIN_TASKS.heartbeat_ping(tick(tier, tier === "high" || tier === "normal" ? 100 : 0), legacy());
      expect(r.shouldWake, tier).toBe(false);
    }
    expect(JSON.parse(db.getKV("last_distress")!).level).toBe("dead");
  });

  it("NOW (step 3): check_credits only records the balance; no wake, no dead timer, no state change (moved to the survival watch)", async () => {
    db.setKV("prev_credit_tier", "normal");
    for (const [tier, cents] of [["low_compute", 30], ["critical", 0], ["normal", 100]] as const) {
      expect((await BUILTIN_TASKS.check_credits(tick(tier, cents), legacy())).shouldWake, tier).toBe(false);
    }
    db.setKV("zero_credits_since", new Date(Date.now() - 61 * 60_000).toISOString());
    await BUILTIN_TASKS.check_credits(tick("critical", 0), legacy());
    expect(db.getAgentState()).not.toBe("dead");
    expect(JSON.parse(db.getKV("last_credit_check")!)).toMatchObject({ credits: 0, tier: "critical" });
  });

  it("NOW (step 3, F1/F3): the survival watch sets dead after the grace and leaves it only above $0 (survival-tier-watch.test.ts)", async () => {
    const { evaluateSurvival } = await import("../survival/tier-watch.js");
    const { DEFAULT_SURVIVAL_SETTINGS } = await import("../survival/settings.js");
    const t0 = Date.now();
    const at = (cents: number, min: number) => evaluateSurvival(db.raw, { balanceCents: cents, balanceStatus: "live", balanceTier: getSurvivalTier(cents) },
      DEFAULT_SURVIVAL_SETTINGS, { now: t0 + min * 60_000, log: () => {} });
    at(0, 0);
    at(0, 59);
    expect(db.getAgentState()).not.toBe("dead");
    at(0, 60);
    expect(db.getAgentState()).toBe("dead");
    at(100, 61);
    expect(db.getAgentState()).toBe("sleeping");
  });
});

describe("wake requests and the sleep floor", () => {
  it("a wake event still ends a sleep at the next 30 s check; distress pings no longer create one, tier changes at most one per gap", async () => {
    let t = 0;
    insertWakeEvent(db.raw, "heartbeat", "Survival tier changed: normal → low_compute (balance $0.30)", {});
    const end = await waitForSleepOrWake(db.raw, 3_600_000, { now: () => t, sleep: async (ms) => { t += ms; } });
    expect(end).toMatchObject({ woken: true, source: "heartbeat" });
    expect(t).toBe(30_000);
  });
});

describe("agent loop in low tiers", () => {
  it("critical (0 cents): low-compute mode on and the model IS called", async () => {
    const conway = new MockConwayClient();
    conway.creditsCents = 0;
    const inference = new MockInferenceClient([noToolResponse("broke")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(inference.lowComputeMode).toBe(true);
    expect(inference.calls.length).toBeGreaterThan(0);
  });

  it("NOW (step 3, F1): a wake in state 'dead' does nothing: no model call, state stays dead", async () => {
    db.setAgentState("dead");
    const conway = new MockConwayClient();
    conway.creditsCents = 0; // the heartbeat's own-balance dead: zero for the grace, balance tier still "critical"
    const inference = new MockInferenceClient([noToolResponse("still here")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
  });
});
