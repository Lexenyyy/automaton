/**
 * Fork, Phase 1: a restart honours a pending sleep (--wake-now overrides).
 */

import fs from "fs";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity, noToolResponse } from "./mocks.js";
import { runAgentLoop } from "../agent/loop.js";
import { AGENT_TURN_TIER_KEY } from "../survival/tier-watch.js";
import { consumeNextWakeEvent, insertWakeEvent } from "../state/database.js";
import { dropStaleWakeEvents, pendingStartupSleep, waitForSleepOrWake } from "../agent/startup-sleep.js";

const NOW = Date.parse("2026-11-16T15:35:08.000Z");

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());

const get = (k: string) => db.getKV(k);

describe("pendingStartupSleep", () => {
  it("honours a future sleep_until, with the last wake-end reason", () => {
    db.setKV("sleep_until", "2026-11-16T16:34:42.000Z");
    db.setKV("sleep_reason", "Sleeping after recording initial SOUL.md content");
    db.setKV("last_wake_end", JSON.stringify({ reason: "agent chose sleep", at: "2026-11-16T15:34:42.000Z" }));
    expect(pendingStartupSleep(get, NOW, false)).toEqual({
      untilMs: Date.parse("2026-11-16T16:34:42.000Z"),
      reason: "agent chose sleep",
    });
  });

  it("falls back to sleep_reason without a last wake end", () => {
    db.setKV("sleep_until", "2026-11-16T16:00:00.000Z");
    db.setKV("sleep_reason", "nothing to do");
    expect(pendingStartupSleep(get, NOW, false)?.reason).toBe("nothing to do");
  });

  it("--wake-now, a past or missing or malformed sleep_until: no pending sleep", () => {
    db.setKV("sleep_until", "2026-11-16T16:00:00.000Z");
    expect(pendingStartupSleep(get, NOW, true)).toBeNull();
    db.setKV("sleep_until", "2026-11-16T15:00:00.000Z");
    expect(pendingStartupSleep(get, NOW, false)).toBeNull();
    db.setKV("sleep_until", "not a date");
    expect(pendingStartupSleep(get, NOW, false)).toBeNull();
    db.deleteKV("sleep_until");
    expect(pendingStartupSleep(get, NOW, false)).toBeNull();
  });
});

describe("waitForSleepOrWake", () => {
  it("sleeps until the time in 30 s steps when nothing wakes it", async () => {
    const slept: number[] = [];
    const end = await waitForSleepOrWake(db.raw, NOW + 75_000, {
      now: () => NOW,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(end).toEqual({ woken: false });
    expect(slept).toEqual([30_000, 30_000, 30_000]);
  });

  it("a wake event ends the sleep early", async () => {
    let steps = 0;
    const end = await waitForSleepOrWake(db.raw, NOW + 3_600_000, {
      now: () => NOW,
      sleep: async () => {
        if (++steps === 2) insertWakeEvent(db.raw, "heartbeat", "inbox message");
      },
    });
    expect(end).toEqual({ woken: true, source: "heartbeat", reason: "inbox message" });
    expect(steps).toBe(2);
  });
});

describe("startup race (tier walk, drain 3): a wake from the heartbeat's first check is not lost", () => {
  it("old wake requests are deleted; one queued after that (first heartbeat check) ends the pending sleep", async () => {
    insertWakeEvent(db.raw, "heartbeat", "old: before this start");
    insertWakeEvent(db.raw, "heartbeat", "old: second");
    expect(dropStaleWakeEvents(db.raw)).toBe(2);
    // The heartbeat starts now; its first check sees the tier change at once.
    insertWakeEvent(db.raw, "heartbeat", "Survival tier changed: low_compute → critical (balance $0.07)");
    let steps = 0;
    const end = await waitForSleepOrWake(db.raw, NOW + 3_600_000, { now: () => NOW, sleep: async () => void steps++ });
    expect(end).toEqual({ woken: true, source: "heartbeat", reason: "Survival tier changed: low_compute → critical (balance $0.07)" });
    expect(steps).toBe(1); // the first 30 s check
    expect(consumeNextWakeEvent(db.raw)).toBeUndefined();
  });

  it("drain 1: a tier change to the tier the agent's last turn ran in does not wake it again", async () => {
    db.setKV(AGENT_TURN_TIER_KEY, "normal"); // the restart wake ran in normal
    insertWakeEvent(db.raw, "heartbeat", "Survival tier changed: high → normal (balance $0.34)", { kind: "tier_change", from: "high", to: "normal" });
    const skipped: string[] = [];
    const end = await waitForSleepOrWake(db.raw, NOW + 75_000, { now: () => NOW, sleep: async () => {}, onSkip: (n) => skipped.push(n) });
    expect(end).toEqual({ woken: false });
    expect(skipped).toEqual([
      "Wake request not used (tier change high → normal already seen: the agent's last turn ran in normal): Survival tier changed: high → normal (balance $0.34)",
    ]);
    expect(consumeNextWakeEvent(db.raw)).toBeUndefined();
  });

  it("still wakes: a new tier, a revival, no recorded turn, other requests (also queued behind a skipped one)", async () => {
    const wakes = async () =>
      (await waitForSleepOrWake(db.raw, NOW + 3_600_000, { now: () => NOW, sleep: async () => {} })).woken;
    db.setKV(AGENT_TURN_TIER_KEY, "normal");
    insertWakeEvent(db.raw, "heartbeat", "to low_compute", { kind: "tier_change", from: "normal", to: "low_compute" });
    expect(await wakes()).toBe(true);
    insertWakeEvent(db.raw, "heartbeat", "revived", { kind: "tier_change", from: "dead", to: "normal" });
    expect(await wakes()).toBe(true);
    insertWakeEvent(db.raw, "heartbeat", "inbox message");
    expect(await wakes()).toBe(true);
    insertWakeEvent(db.raw, "heartbeat", "seen", { kind: "tier_change", from: "high", to: "normal" });
    insertWakeEvent(db.raw, "heartbeat", "task wake", { taskName: "check_x" });
    const end = await waitForSleepOrWake(db.raw, NOW + 3_600_000, { now: () => NOW, sleep: async () => {} });
    expect(end).toEqual({ woken: true, source: "heartbeat", reason: "task wake" });
    db.deleteKV(AGENT_TURN_TIER_KEY);
    insertWakeEvent(db.raw, "heartbeat", "no turn recorded", { kind: "tier_change", from: "high", to: "normal" });
    expect(await wakes()).toBe(true);
  });

  it("the agent loop records the tier of a turn the model answered", async () => {
    const inference = new MockInferenceClient([noToolResponse("nothing to do")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway: new MockConwayClient(), inference });
    expect(inference.calls).toHaveLength(1);
    expect(["high", "normal", "low_compute", "critical"]).toContain(db.getKV(AGENT_TURN_TIER_KEY));
  });

  it("run(): old wake requests are deleted before heartbeat.start(), never after; onWakeRequest only logs", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const drop = src.indexOf("dropStaleWakeEvents(db.raw)");
    const start = src.indexOf("heartbeat.start()");
    expect(drop).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(drop);
    expect(src.slice(start)).not.toMatch(/consumeNextWakeEvent|dropStaleWakeEvents/);
    const cb = src.slice(src.indexOf("onWakeRequest:"), src.indexOf("heartbeat.start()"));
    expect(cb).not.toContain("insertWakeEvent");
    // The pending sleep's "sleeping" state is set before the heartbeat can enter dead.
    expect(src.indexOf('if (pending) db.setAgentState("sleeping")')).toBeLessThan(start);
  });
});
