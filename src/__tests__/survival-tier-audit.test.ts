/**
 * Phase 4 step 1: characterization of the survival tiers AS THEY ARE (no
 * behaviour change). Each "TODAY:" test pins current behaviour that a later
 * Phase 4 step changes on purpose; that step flips the test and says so in
 * docs/CHANGELOG-FORK.md. See docs/ROADMAP.md "Phase 4" for the tier table.
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
  it("high/normal/low_compute → gpt-4.1-mini, critical → gpt-4.1-nano, dead → none (no model call)", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG));
    const pick = (t: Parameters<typeof router.selectModel>[0]) => router.selectModel(t, "agent_turn")?.modelId ?? null;
    expect(pick("high")).toBe("gpt-4.1-mini");
    expect(pick("normal")).toBe("gpt-4.1-mini");
    expect(pick("low_compute")).toBe("gpt-4.1-mini");
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
  it("TODAY: heartbeat_ping asks to wake the agent on EVERY ping (every 15 min) while critical or dead (step 3 changes this)", async () => {
    for (const tier of ["critical", "dead"]) {
      const r = await BUILTIN_TASKS.heartbeat_ping(tick(tier, 0), legacy());
      expect(r.shouldWake, tier).toBe(true);
      expect(r.message).toMatch(new RegExp(`Distress: ${tier}`));
    }
    expect(JSON.parse(db.getKV("last_distress")!).level).toBe("dead");
    for (const tier of ["high", "normal", "low_compute"]) {
      expect((await BUILTIN_TASKS.heartbeat_ping(tick(tier, 100), legacy())).shouldWake, tier).toBe(false);
    }
  });

  it("check_credits: wakes on a change INTO critical only (not into low_compute or back up)", async () => {
    db.setKV("prev_credit_tier", "normal");
    expect((await BUILTIN_TASKS.check_credits(tick("low_compute", 30), legacy())).shouldWake).toBe(false);
    expect((await BUILTIN_TASKS.check_credits(tick("critical", 5), legacy())).shouldWake).toBe(true);
    expect((await BUILTIN_TASKS.check_credits(tick("normal", 100), legacy())).shouldWake).toBe(false);
  });

  it("check_credits: dead only after 1 hour (hardcoded) at <= 0; above zero clears the timer", async () => {
    db.setKV("prev_credit_tier", "critical");
    await BUILTIN_TASKS.check_credits(tick("critical", 0), legacy());
    expect(db.getKV("zero_credits_since")).toBeTruthy();
    expect(db.getAgentState()).not.toBe("dead");
    db.setKV("zero_credits_since", new Date(Date.now() - 61 * 60_000).toISOString());
    const r = await BUILTIN_TASKS.check_credits(tick("critical", 0), legacy());
    expect(r.shouldWake).toBe(true);
    expect(db.getAgentState()).toBe("dead");
    await BUILTIN_TASKS.check_credits(tick("normal", 100), legacy());
    expect(db.getKV("zero_credits_since")).toBeUndefined();
    expect(db.getAgentState()).toBe("dead"); // TODAY: funding clears the timer but does not leave "dead" here
  });

  it("an unavailable balance never starts or advances the dead timer", async () => {
    const ctx = { ...tick("critical", 0), balanceStatus: "unavailable" } as TickContext;
    await BUILTIN_TASKS.check_credits(ctx, legacy());
    expect(db.getKV("zero_credits_since")).toBeUndefined();
  });
});

describe("wake requests and the sleep floor", () => {
  it("TODAY: a heartbeat wake event ends a sleep at the next 30 s check, before sleepConfig.minSeconds (step 3 changes this for distress)", async () => {
    let t = 0;
    insertWakeEvent(db.raw, "heartbeat", "Distress: critical", {});
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

  it("TODAY: a wake in state 'dead' overwrites it (waking → running/critical) and calls the model (step 3 changes this)", async () => {
    db.setAgentState("dead");
    const conway = new MockConwayClient();
    conway.creditsCents = 0; // the heartbeat's own-balance dead: zero for 1 h, tier still "critical"
    const inference = new MockInferenceClient([noToolResponse("still here")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(inference.calls.length).toBeGreaterThan(0);
    expect(db.getAgentState()).not.toBe("dead");
  });
});
