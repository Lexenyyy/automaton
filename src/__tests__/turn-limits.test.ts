/**
 * Fork, Phase 2: per-wake turn cap (config.maxTurnsPerCycle).
 */

import { describe, it, expect } from "vitest";
import { checkMaxTurnsPerCycle, resolveMaxTurnsPerWake, DEFAULT_MAX_TURNS_PER_WAKE } from "../agent/turn-limits.js";
import { buildStatusSnapshot } from "../agent/status-snapshot.js";
import { createTestConfig, createTestDb } from "./mocks.js";

describe("per-wake turn cap", () => {
  it("accepts whole numbers 1..100 and unset", () => {
    expect(checkMaxTurnsPerCycle({})).toBeNull();
    expect(checkMaxTurnsPerCycle({ maxTurnsPerCycle: 1 })).toBeNull();
    expect(checkMaxTurnsPerCycle({ maxTurnsPerCycle: 6 })).toBeNull();
    expect(checkMaxTurnsPerCycle({ maxTurnsPerCycle: 100 })).toBeNull();
  });

  it("refuses zero, negatives, fractions, too large and non-numbers", () => {
    for (const v of [0, -1, 2.5, 101, Number.NaN, "6" as any, null as any]) {
      expect(checkMaxTurnsPerCycle({ maxTurnsPerCycle: v })).toMatch(/maxTurnsPerCycle must be a whole number from 1 to 100/);
    }
  });

  it("resolves the configured cap, else the default", () => {
    expect(resolveMaxTurnsPerWake({ maxTurnsPerCycle: 6 })).toBe(6);
    expect(resolveMaxTurnsPerWake({})).toBe(DEFAULT_MAX_TURNS_PER_WAKE);
    expect(resolveMaxTurnsPerWake({ maxTurnsPerCycle: 0 })).toBe(DEFAULT_MAX_TURNS_PER_WAKE);
  });

  it("the wake status tells the agent the cap", () => {
    const db = createTestDb();
    try {
      const text = buildStatusSnapshot({
        config: createTestConfig({ maxTurnsPerCycle: 6 }),
        financial: { creditsCents: 400, usdcBalance: 0, lastChecked: new Date().toISOString() } as any,
        db,
      });
      expect(text).toContain("Turns this wake: at most 6 (the wake is ended after that; sleep before it)");
    } finally {
      db.close();
    }
  });
});
// The testnet template's value (6) is checked by agent:verify (preflight "wake limits" line).
