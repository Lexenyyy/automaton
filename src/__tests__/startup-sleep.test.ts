/**
 * Fork, Phase 1: a restart honours a pending sleep (--wake-now overrides).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./mocks.js";
import { insertWakeEvent } from "../state/database.js";
import { pendingStartupSleep, waitForSleepOrWake } from "../agent/startup-sleep.js";

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
