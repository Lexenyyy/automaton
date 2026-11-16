/**
 * Graceful shutdown waits for in-flight model calls to be recorded (fork, Phase 1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6, MIGRATION_V12, applyMigrationV14 } from "../state/schema.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import {
  beginInferenceShutdown,
  getInFlightInferenceCount,
  resetInFlightInferenceForTests,
  waitForInFlightInference,
} from "../inference/in-flight.js";
import { getLifetimeInferenceCostMc } from "../state/ledger.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  resetInFlightInferenceForTests();
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  db.exec(MIGRATION_V12);
  applyMigrationV14(db);
});
afterEach(() => {
  db.close();
  resetInFlightInferenceForTests();
});

const tracker = () => new InferenceBudgetTracker(db, { ...DEFAULT_MODEL_STRATEGY_CONFIG, hourlyBudgetCents: 0 });

describe("in-flight model calls", () => {
  it("a reservation counts as in flight until released; release is idempotent", () => {
    const t = tracker();
    const a = t.tryReserve(0.3, "m");
    const b = t.tryReserve(0, "free-local-model");
    expect(getInFlightInferenceCount()).toBe(2);
    if (a.allowed) {
      a.release();
      a.release();
    }
    expect(getInFlightInferenceCount()).toBe(1);
    if (b.allowed) b.release();
    expect(getInFlightInferenceCount()).toBe(0);
  });

  it("a refused call is not counted", () => {
    const t = new InferenceBudgetTracker(db, { ...DEFAULT_MODEL_STRATEGY_CONFIG, perCallCeilingCents: 1 });
    expect(t.tryReserve(5, "m").allowed).toBe(false);
    expect(getInFlightInferenceCount()).toBe(0);
  });

  it("shutdown waits until the running call's cost is recorded, then resolves", async () => {
    const t = tracker();
    const r = t.tryReserve(0.4, "m");
    expect(r.allowed).toBe(true);
    beginInferenceShutdown();
    const waiting = waitForInFlightInference(5_000);
    // The call finishes: cost recorded, then the reservation released (as router/metered client do).
    setTimeout(() => {
      t.recordCost({
        sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai", inputTokens: 1000,
        outputTokens: 10, costCents: 1, costMc: 416, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
      });
      if (r.allowed) r.release();
    }, 20);
    await expect(waiting).resolves.toBe(true);
    expect(getLifetimeInferenceCostMc(db)).toBe(416);
  });

  it("after shutdown begins, no new call is admitted", () => {
    beginInferenceShutdown();
    const r = tracker().tryReserve(0.1, "m");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/shutting down/);
    expect(getInFlightInferenceCount()).toBe(0);
  });

  it("the wait gives up after the timeout and reports false", async () => {
    tracker().tryReserve(0.1, "m");
    await expect(waitForInFlightInference(30)).resolves.toBe(false);
    await expect(waitForInFlightInference(30)).resolves.toBe(false);
  });

  it("with nothing in flight the wait resolves at once", async () => {
    await expect(waitForInFlightInference(10_000)).resolves.toBe(true);
  });
});
