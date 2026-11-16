/**
 * Fork, Phase 2 prep: sleep floor and daily wake cap (sleepConfig).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import {
  DEFAULT_SLEEP_SETTINGS,
  admitWake,
  clampSleepSeconds,
  effectiveSleepUntil,
  getWakesToday,
  nextUtcDay,
  resolveSleepSettings,
} from "../agent/sleep-limits.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-limits-"));
  process.env.HOME = home;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const S = { minSeconds: 1800, maxWakesPerDay: 48 };

describe("sleep settings", () => {
  it("defaults, owner values, and invalid values falling back", () => {
    expect(resolveSleepSettings({})).toEqual(DEFAULT_SLEEP_SETTINGS);
    expect(DEFAULT_SLEEP_SETTINGS).toEqual({ minSeconds: 300, maxWakesPerDay: 48 });
    expect(resolveSleepSettings({ sleepConfig: S })).toEqual(S);
    expect(resolveSleepSettings({ sleepConfig: { minSeconds: 0, maxWakesPerDay: -1 } })).toEqual(DEFAULT_SLEEP_SETTINGS);
    expect(resolveSleepSettings({ sleepConfig: { maxWakesPerDay: 0 } }).maxWakesPerDay).toBe(0);
  });

  it("clamps the tool duration to the floor and refuses invalid ones", () => {
    expect(clampSleepSeconds(60, S)).toEqual({ seconds: 1800, raised: true });
    expect(clampSleepSeconds(3600, S)).toEqual({ seconds: 3600, raised: false });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", undefined]) {
      expect(clampSleepSeconds(bad, S)).toBeNull();
    }
  });

  it("no sleep ends before now + floor, whatever set it (idle 60 s, missing, past)", () => {
    const now = Date.parse("2026-11-16T20:00:00.000Z");
    expect(effectiveSleepUntil(now + 60_000, now, S)).toBe(now + 1_800_000);
    expect(effectiveSleepUntil(now - 5_000, now, S)).toBe(now + 1_800_000);
    expect(effectiveSleepUntil(Number.NaN, now, S)).toBe(now + 1_800_000);
    expect(effectiveSleepUntil(now + 7_200_000, now, S)).toBe(now + 7_200_000);
  });
});

describe("daily wake cap", () => {
  it("admits up to the limit per UTC day, then refuses without counting; resets the next day", () => {
    const day = new Date("2026-11-16T10:00:00.000Z");
    const cap = { minSeconds: 1800, maxWakesPerDay: 3 };
    expect([1, 2, 3].map(() => admitWake(db.raw, cap, day).allowed)).toEqual([true, true, true]);
    expect(admitWake(db.raw, cap, day)).toEqual({ allowed: false, count: 3 });
    expect(getWakesToday(db.raw, day)).toBe(3);
    const next = new Date("2026-11-17T00:00:01.000Z");
    expect(admitWake(db.raw, cap, next)).toEqual({ allowed: true, count: 1 });
    expect(nextUtcDay(day).toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });

  it("0 means no limit", () => {
    const off = { minSeconds: 1800, maxWakesPerDay: 0 };
    for (let i = 0; i < 100; i++) expect(admitWake(db.raw, off).allowed).toBe(true);
  });

  it("the loop sleeps until the next UTC day without a model call once the cap is reached", async () => {
    const config = { ...createTestConfig(), sleepConfig: { minSeconds: 1800, maxWakesPerDay: 2 } };
    db.setKV("wake_count_day", JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 2 }));
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await runAgentLoop({ identity: createTestIdentity(), config, db, conway: new MockConwayClient(), inference });
    expect(inference.calls.length).toBe(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBe(nextUtcDay(new Date()).toISOString());
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toBe("wake limit: 2 wakes today (max 2 per day)");
  });
});

describe("sleep tool", () => {
  const tools = createBuiltinTools("test-sandbox-id");
  const run = (config: AutomatonConfig, args: Record<string, unknown>) => {
    const ctx: ToolContext = {
      identity: createTestIdentity(),
      config,
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
    const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY));
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    return executeTool("sleep", args, tools, ctx, engine, turn);
  };
  const config = { ...createTestConfig(), sleepConfig: S };

  it("sleep(60) sleeps the minimum and says so", async () => {
    const before = Date.now();
    const r = await run(config, { duration_seconds: 60, reason: "test" });
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("Entering sleep mode for 1800s (the minimum; you asked for 60s)");
    expect(new Date(db.getKV("sleep_until")!).getTime()).toBeGreaterThanOrEqual(before + 1_800_000);
  });

  it("refuses zero, negative and non-number durations", async () => {
    for (const d of [0, -10, "soon"]) {
      const r = await run(config, { duration_seconds: d });
      expect(r.error).toMatch(/duration_seconds must be a positive number of seconds \(minimum 1800\)/);
    }
    expect(db.getKV("sleep_until")).toBeUndefined();
  });
});
