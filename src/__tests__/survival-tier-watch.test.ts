/**
 * Phase 4 step 3: survival watch on every heartbeat tick (src/survival/tier-watch.ts),
 * the run loop while dead (src/survival/dead-state.ts), and the agent loop guard.
 * Owner requirements: zero model calls in dead and no agent-loop re-entry; leaving
 * dead only when the heartbeat sees a balance above $0; one wake per tier change
 * with a minimum gap (no wake storm); every change recorded and logged as INFO.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { evaluateSurvival, getTierChanges, TIER_KEY } from "../survival/tier-watch.js";
import { waitWhileDead } from "../survival/dead-state.js";
import { DEFAULT_SURVIVAL_SETTINGS, type SurvivalSettings } from "../survival/settings.js";
import { getSurvivalTier } from "../conway/credits.js";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { runAgentLoop } from "../agent/loop.js";
import { consumeNextWakeEvent, insertWakeEvent, upsertHeartbeatSchedule } from "../state/database.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity, noToolResponse } from "./mocks.js";
import type { AutomatonDatabase, SurvivalTier } from "../types.js";

const S: SurvivalSettings = { ...DEFAULT_SURVIVAL_SETTINGS, deadGraceMinutes: 5, tierWakeMinGapMinutes: 30 };
const T0 = Date.parse("2026-11-23T12:00:00.000Z");
const MIN = 60_000;

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const tick = (cents: number, atMin: number, opts: { status?: string; log?: (m: string) => void; settings?: SurvivalSettings } = {}) =>
  evaluateSurvival(db.raw, { balanceCents: cents, balanceStatus: opts.status ?? "live", balanceTier: getSurvivalTier(cents, opts.settings ?? S) },
    opts.settings ?? S, { now: T0 + atMin * MIN, log: opts.log ?? (() => {}) });

describe("entering dead", () => {
  it("balance below $0: dead at once, no wake", () => {
    tick(100, 0);
    const r = tick(-1, 1);
    expect(r).toMatchObject({ tier: "dead", enteredDead: true });
    expect(r.wakeReason).toBeUndefined();
    expect(db.getAgentState()).toBe("dead");
    expect(r.change).toMatchObject({ from: "normal", to: "dead", woke: false });
  });

  it("at $0: critical first, dead only after deadGraceMinutes (5)", () => {
    tick(100, 0);
    expect(tick(0, 1).tier).toBe("critical");
    expect(tick(0, 5).tier).toBe("critical"); // 4 min at $0
    const r = tick(0, 6); // 5 min at $0
    expect(r).toMatchObject({ tier: "dead", enteredDead: true });
    expect(r.change).toMatchObject({ from: "critical", to: "dead", woke: false });
  });

  it("an unavailable balance never starts the timer or changes anything", () => {
    tick(100, 0);
    for (let m = 1; m <= 20; m++) tick(0, m, { status: "unavailable" });
    expect(db.getKV("zero_credits_since")).toBeUndefined();
    expect(db.getAgentState()).not.toBe("dead");
    expect(getTierChanges(db.raw)).toEqual([]);
  });
});

describe("leaving dead: only when the heartbeat sees a balance above $0", () => {
  beforeEach(() => { tick(100, 0); tick(-5, 1); expect(db.getAgentState()).toBe("dead"); });

  it("stays dead at $0, below $0, and on an unavailable read", () => {
    tick(0, 2);
    tick(-3, 3);
    tick(500, 4, { status: "unavailable" });
    expect(db.getAgentState()).toBe("dead");
  });

  it("above $0: state cleared to sleeping, change recorded, one wake", () => {
    db.setKV("sleep_until", new Date(T0 + 999 * MIN).toISOString());
    const r = tick(5, 10);
    expect(r).toMatchObject({ leftDead: true, tier: "critical" });
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeUndefined();
    expect(r.change).toMatchObject({ from: "dead", to: "critical", balanceCents: 5, woke: true });
    expect(r.wakeReason).toBe("Survival tier changed: dead → critical (balance $0.05)");
  });
});

describe("tier changes: recorded, logged as INFO, one wake per change with a minimum gap", () => {
  it("the first observation is not a change; an unchanged tier never wakes", () => {
    expect(tick(100, 0).change).toBeUndefined();
    for (let m = 1; m < 30; m++) expect(tick(100 + m, m).wakeReason).toBeUndefined();
    expect(getTierChanges(db.raw)).toEqual([]);
    expect(db.getKV(TIER_KEY)).toBe("normal");
  });

  it("every change is logged as INFO with old tier, new tier and balance", () => {
    const logs: string[] = [];
    tick(600, 0, { log: (m) => logs.push(m) });
    tick(400, 1, { log: (m) => logs.push(m) });
    tick(30, 2, { log: (m) => logs.push(m) });
    expect(logs).toEqual([
      "Tier change: high → normal (balance $4.00); agent woken",
      "Tier change: normal → low_compute (balance $0.30); no wake: within 30 min of the last tier-change wake",
    ]);
    expect(getTierChanges(db.raw).map((c) => [c.from, c.to, c.balanceCents, c.woke])).toEqual([
      ["high", "normal", 400, true], ["normal", "low_compute", 30, false],
    ]);
  });

  it("a balance bouncing across a boundary: every change recorded, at most one wake per gap", () => {
    tick(60, 0); // normal
    const woke: number[] = [];
    for (let m = 1; m <= 60; m++) {
      const r = tick(m % 2 ? 40 : 60, m); // normal ↔ low_compute every minute
      if (r.wakeReason) woke.push(m);
    }
    expect(getTierChanges(db.raw)).toHaveLength(60);
    expect(woke).toEqual([1, 31]); // gap 30 min
  });

  it("the gap is a setting (1 minute: wakes again a minute later)", () => {
    const s1 = { ...S, tierWakeMinGapMinutes: 1 };
    tick(60, 0, { settings: s1 });
    expect(tick(40, 1, { settings: s1 }).wakeReason).toBeTruthy();
    expect(tick(60, 1.5, { settings: s1 }).wakeReason).toBeUndefined();
    expect(tick(40, 2, { settings: s1 }).wakeReason).toBeTruthy();
  });

  it("the scheduler turns a tier-change wake into exactly one wake event and callback", async () => {
    let cents = 100;
    const onWake = vi.fn();
    const sched = new DurableScheduler(db.raw, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 }, new Map(),
      { identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), db, conway: new MockConwayClient() }, onWake);
    vi.spyOn(sched, "balanceSource").mockReturnValue({ read: async () => ({ balanceCents: cents, status: "live", usdcBalance: 0 }) } as any);
    await sched.tick();
    cents = 30;
    await sched.tick();
    await sched.tick();
    await sched.tick();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(consumeNextWakeEvent(db.raw)?.reason).toBe("Survival tier changed: normal → low_compute (balance $0.30)");
    expect(consumeNextWakeEvent(db.raw)).toBeUndefined();
  });
});

describe("dead: zero model calls across several heartbeat ticks, no agent-loop re-entry", () => {
  it("the run loop waits through 8 ticks at $0 without a model call, then resumes once the heartbeat sees funds", async () => {
    let cents = 0;
    const inference = new MockInferenceClient([noToolResponse("must not run")]);
    const config = createTestConfig({ balanceSource: "own", survival: { deadGraceMinutes: 5 } });
    const sched = new DurableScheduler(db.raw, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 }, new Map(Object.entries(BUILTIN_TASKS)),
      { identity: createTestIdentity(), config, db, conway: new MockConwayClient() });
    vi.spyOn(sched, "balanceSource").mockReturnValue({ read: async () => ({ balanceCents: cents, status: "live", usdcBalance: 0 }) } as any);
    for (const task of ["heartbeat_ping", "check_credits"]) {
      upsertHeartbeatSchedule(db.raw, { taskName: task, cronExpression: "* * * * *", intervalMs: null, enabled: 1, priority: 0, timeoutMs: 30_000,
        maxRetries: 0, tierMinimum: "dead", lastRunAt: null, nextRunAt: null, lastResult: null, lastError: null, runCount: 0, failCount: 0, leaseOwner: null, leaseExpiresAt: null });
    }
    db.setAgentState("dead");
    db.setKV(TIER_KEY, "dead");
    insertWakeEvent(db.raw, "heartbeat", "stale distress", {}); // ignored while dead

    let ticks = 0;
    let agentLoopEntries = 0;
    const w = await waitWhileDead(db.raw, {
      sleep: async () => {
        ticks++;
        if (ticks === 9) cents = 25; // owner funds the wallet
        await sched.tick();
        // Even if something called the agent loop while dead, it must not call the model.
        if (db.getAgentState() === "dead") {
          agentLoopEntries++;
          await runAgentLoop({ identity: createTestIdentity(), config, db, conway: new MockConwayClient(), inference });
        }
      },
    });
    expect(w.polls).toBe(9);
    expect(w.ignoredWakes).toBe(1);
    expect(agentLoopEntries).toBe(8);
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(getTierChanges(db.raw).at(-1)).toMatchObject({ from: "dead", to: "low_compute", balanceCents: 25, woke: true });
    // The revival wake stays queued for the agent loop.
    expect(consumeNextWakeEvent(db.raw)?.reason).toBe("Survival tier changed: dead → low_compute (balance $0.25)");
  });

  it("the agent loop called in dead returns at once: no model call, no wake counted, state stays dead", async () => {
    db.setAgentState("dead");
    const inference = new MockInferenceClient([noToolResponse("must not run")]);
    const conway = new MockConwayClient();
    conway.creditsCents = 500;
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
    expect(db.getKV("wake_count_day")).toBeUndefined();
  });

  it("a wake whose balance turns negative ends as dead before any model call", async () => {
    const inference = new MockInferenceClient([noToolResponse("must not run")]);
    const conway = new MockConwayClient();
    conway.creditsCents = -10;
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toBe("dead: balance below $0");
  });
});

describe("tiers in effect", () => {
  it("the effective tier is 'dead' while the state is dead, whatever the balance tier", () => {
    tick(100, 0);
    tick(-1, 1);
    const r = tick(0, 2);
    expect(r.tier as SurvivalTier).toBe("dead");
  });
});
