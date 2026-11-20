/**
 * Heartbeat history retention (fork, after run 6): config.heartbeatHistoryDays,
 * pruned by the scheduler at most once an hour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import {
  checkHeartbeatHistoryDays,
  resolveHeartbeatHistoryDays,
  DEFAULT_HEARTBEAT_HISTORY_DAYS,
  HEARTBEAT_PRUNE_INTERVAL_MS,
} from "../heartbeat/history-retention.js";
import { insertHeartbeatHistory, upsertHeartbeatSchedule } from "../state/database.js";
import { MockConwayClient, createTestDb, createTestIdentity, createTestConfig } from "./mocks.js";
import type { AutomatonDatabase, HeartbeatConfig } from "../types.js";

const HB: HeartbeatConfig = { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 };
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

function addRow(db: AutomatonDatabase, id: string, ageDays: number, result: "success" | "failure" = "success"): void {
  const at = new Date(NOW - ageDays * DAY).toISOString();
  insertHeartbeatHistory(db.raw, {
    id, taskName: "t", startedAt: at, completedAt: at, result, durationMs: 1,
    error: result === "failure" ? "boom" : null, idempotencyKey: null,
  });
}

function count(db: AutomatonDatabase): number {
  return (db.raw.prepare("SELECT COUNT(*) c FROM heartbeat_history").get() as { c: number }).c;
}

function makeScheduler(db: AutomatonDatabase, heartbeatHistoryDays?: number): DurableScheduler {
  const config = { ...createTestConfig(), heartbeatHistoryDays };
  return new DurableScheduler(db.raw, HB, new Map(), {
    identity: createTestIdentity(), config, db, conway: new MockConwayClient(),
  });
}

describe("heartbeat history retention", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    // heartbeat_history.task_name references heartbeat_schedule; disabled, so tick() runs nothing.
    upsertHeartbeatSchedule(db.raw, {
      taskName: "t", cronExpression: "* * * * *", intervalMs: null, enabled: 0, priority: 0,
      timeoutMs: 30_000, maxRetries: 0, tierMinimum: "dead", lastRunAt: null, nextRunAt: null,
      lastResult: null, lastError: null, runCount: 0, failCount: 0, leaseOwner: null, leaseExpiresAt: null,
    });
  });
  afterEach(() => { db.close(); });

  it("validates the setting", () => {
    expect(checkHeartbeatHistoryDays({})).toBeNull();
    expect(checkHeartbeatHistoryDays({ heartbeatHistoryDays: 0 })).toBeNull();
    expect(checkHeartbeatHistoryDays({ heartbeatHistoryDays: 365 })).toBeNull();
    for (const bad of [-1, 366, 1.5, "7" as unknown as number]) {
      expect(checkHeartbeatHistoryDays({ heartbeatHistoryDays: bad })).toMatch(/heartbeatHistoryDays/);
    }
    expect(resolveHeartbeatHistoryDays({})).toBe(DEFAULT_HEARTBEAT_HISTORY_DAYS);
    expect(resolveHeartbeatHistoryDays({ heartbeatHistoryDays: -3 })).toBe(DEFAULT_HEARTBEAT_HISTORY_DAYS);
    expect(resolveHeartbeatHistoryDays({ heartbeatHistoryDays: 2 })).toBe(2);
  });

  it("deletes rows older than the retention (successes and failures), keeps newer ones", () => {
    addRow(db, "a", 10); addRow(db, "b", 8, "failure"); addRow(db, "c", 6); addRow(db, "d", 0.1);
    const s = makeScheduler(db, 7);
    expect(s.maybePruneHistory(NOW)).toBe(2);
    const ids = (db.raw.prepare("SELECT id FROM heartbeat_history ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["c", "d"]);
  });

  it("prunes at most once per interval", () => {
    const s = makeScheduler(db, 1);
    addRow(db, "a", 2);
    expect(s.maybePruneHistory(NOW)).toBe(1);
    addRow(db, "b", 2);
    expect(s.maybePruneHistory(NOW + HEARTBEAT_PRUNE_INTERVAL_MS - 1)).toBe(0);
    expect(count(db)).toBe(1);
    expect(s.maybePruneHistory(NOW + HEARTBEAT_PRUNE_INTERVAL_MS)).toBe(1);
    expect(count(db)).toBe(0);
  });

  it("keeps everything with 0, and uses the 7-day default when unset", () => {
    addRow(db, "a", 400);
    expect(makeScheduler(db, 0).maybePruneHistory(NOW)).toBe(0);
    expect(count(db)).toBe(1);
    addRow(db, "b", 8); addRow(db, "c", 6);
    expect(makeScheduler(db).maybePruneHistory(NOW)).toBe(2);
    expect(count(db)).toBe(1);
  });

  it("runs from tick()", async () => {
    addRow(db, "old", 30);
    await makeScheduler(db, 7).tick();
    expect(count(db)).toBe(0);
  });
});
