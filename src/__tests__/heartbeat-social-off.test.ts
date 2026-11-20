/**
 * Fork (run 6 follow-up H2): without a social client the heartbeat does not run
 * check_social_inbox (upstream ran it every 2 minutes as a no-op).
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildHeartbeatTaskMap } from "../heartbeat/daemon.js";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { upsertHeartbeatSchedule } from "../state/database.js";
import { MockConwayClient, createTestDb, createTestIdentity, createTestConfig } from "./mocks.js";
import type { AutomatonDatabase, SocialClientInterface } from "../types.js";

const social = { poll: async () => ({ messages: [] }) } as unknown as SocialClientInterface;

describe("heartbeat without a social relay", () => {
  let db: AutomatonDatabase | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  it("leaves out check_social_inbox only when there is no social client", () => {
    const off = buildHeartbeatTaskMap(BUILTIN_TASKS, undefined);
    const on = buildHeartbeatTaskMap(BUILTIN_TASKS, social);
    expect(off.has("check_social_inbox")).toBe(false);
    expect(on.has("check_social_inbox")).toBe(true);
    expect([...off.keys()].sort()).toEqual(Object.keys(BUILTIN_TASKS).filter((n) => n !== "check_social_inbox").sort());
  });

  it("a due check_social_inbox is neither run nor recorded", async () => {
    db = createTestDb();
    upsertHeartbeatSchedule(db.raw, {
      taskName: "check_social_inbox", cronExpression: "*/2 * * * *", intervalMs: null, enabled: 1, priority: 0,
      timeoutMs: 30_000, maxRetries: 1, tierMinimum: "dead", lastRunAt: null, nextRunAt: null,
      lastResult: null, lastError: null, runCount: 0, failCount: 0, leaseOwner: null, leaseExpiresAt: null,
    });
    const scheduler = new DurableScheduler(db.raw, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      buildHeartbeatTaskMap(BUILTIN_TASKS, undefined),
      { identity: createTestIdentity(), config: createTestConfig(), db, conway: new MockConwayClient() });
    await scheduler.tick();
    const rows = (db.raw.prepare("SELECT COUNT(*) c FROM heartbeat_history").get() as { c: number }).c;
    const sched = db.raw.prepare("SELECT run_count, lease_owner FROM heartbeat_schedule WHERE task_name = 'check_social_inbox'").get() as { run_count: number; lease_owner: string | null };
    expect(rows).toBe(0);
    expect(sched.run_count).toBe(0);
    expect(sched.lease_owner).toBeNull();
  });
});
