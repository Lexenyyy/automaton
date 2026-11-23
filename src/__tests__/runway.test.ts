/**
 * Runway estimate (fork, Phase 4 step 4): src/survival/runway.ts and where it is shown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeRunway, formatRunway, formatDuration, runwayLine } from "../survival/runway.js";
import { DEFAULT_SURVIVAL_SETTINGS } from "../survival/settings.js";
import { insertLedgerEntry } from "../state/ledger.js";
import { getActivityReport, formatActivityReport } from "../state/activity-report.js";
import { buildStatusSnapshot } from "../agent/status-snapshot.js";
import { createTestConfig, createTestDb } from "./mocks.js";
import type { AutomatonDatabase, FinancialState } from "../types.js";

const NOW = new Date("2026-11-23T18:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const D = DEFAULT_SURVIVAL_SETTINGS;

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

const grant = (cents: number, hoursAgo: number) =>
  insertLedgerEntry(db.raw, { kind: "owner_grant", amountCents: cents, livemode: true, source: "test", occurredAt: ago(hoursAgo) });
const spend = (mc: number, hoursAgo: number) =>
  insertLedgerEntry(db.raw, { kind: "inference_cost", amountCents: -Math.ceil(mc / 1000), amountMc: -mc, livemode: true, source: "test", occurredAt: ago(hoursAgo) });

describe("burn rate", () => {
  it("inference spend over the last 24 h / 24 (older spend ignored)", () => {
    grant(500, 48);
    for (let h = 1; h <= 24; h++) spend(500, h - 0.5); // 0.5¢ per hour, 24 calls inside the window
    spend(90_000, 30); // 90¢ 30 h ago: outside the window
    const r = computeRunway(db.raw, 400, D, NOW);
    expect(r.windowHours).toBe(24);
    expect(r.burnCentsPerHour).toBeCloseTo(0.5, 6);
    expect(r.tier).toBe("normal");
    expect(r.nextTier).toEqual({ tier: "low_compute", boundaryCents: 50, hours: 700 }); // (400 - 50) / 0.5
    expect(r.zeroHours).toBe(800);
  });

  it("a young agent: divided by the hours it has lived, not 24", () => {
    grant(500, 2);
    spend(1000, 1.5);
    spend(1000, 0.5); // 2¢ in 2 h
    const r = computeRunway(db.raw, 100, D, NOW);
    expect(r.windowHours).toBe(2);
    expect(r.burnCentsPerHour).toBeCloseTo(1, 6);
  });

  it("at least one hour of history (no wild extrapolation in the first minutes)", () => {
    grant(500, 0.1);
    spend(1000, 0.05);
    const r = computeRunway(db.raw, 100, D, NOW);
    expect(r.windowHours).toBe(1);
    expect(r.burnCentsPerHour).toBeCloseTo(1, 6);
  });

  it("no spend: no estimate (never infinite)", () => {
    grant(500, 10);
    const r = computeRunway(db.raw, 500, D, NOW);
    expect(r.burnCentsPerHour).toBe(0);
    expect(r.zeroHours).toBeNull();
    expect(r.nextTier?.hours).toBeNull();
    expect(formatRunway(r)).toBe("Runway: no inference spend in the last 10 h, so no estimate (balance $5.00)");
  });
});

describe("next tier per tier, with the owner's thresholds", () => {
  beforeEach(() => { grant(1000, 24); for (let h = 1; h <= 24; h++) spend(1000, h - 0.5); }); // 1¢/h
  const next = (balance: number, t = D) => computeRunway(db.raw, balance, t, NOW).nextTier;

  it("high → normal at highCents; normal → low_compute; low_compute → critical; critical → dead at $0", () => {
    expect(next(615)).toEqual({ tier: "normal", boundaryCents: 500, hours: 115 });
    expect(next(100)).toEqual({ tier: "low_compute", boundaryCents: 50, hours: 50 });
    expect(next(30)).toEqual({ tier: "critical", boundaryCents: 10, hours: 20 });
    expect(next(5)).toEqual({ tier: "dead", boundaryCents: 0, hours: 5 });
  });

  it("scaled thresholds (like the tier walk) are used", () => {
    const walk = { highCents: 40, normalCents: 30, lowComputeCents: 15 };
    expect(next(45, walk)).toEqual({ tier: "normal", boundaryCents: 40, hours: 5 });
    expect(next(20, walk)).toEqual({ tier: "critical", boundaryCents: 15, hours: 5 });
  });

  it("at or below $0: no runway", () => {
    expect(formatRunway(computeRunway(db.raw, 0, D, NOW))).toBe("Runway: none (balance $0.00; dead below $0 or after the grace at $0)");
    expect(computeRunway(db.raw, -5, D, NOW)).toMatchObject({ tier: "dead", nextTier: null, zeroHours: 0 });
  });

  it("formats the line", () => {
    expect(formatRunway(computeRunway(db.raw, 615, D, NOW))).toBe(
      "Runway: $6.15 lasts ~25 d 15 h at 1.0¢/h (inference, last 24 h); normal at $5.00 in ~4 d 19 h",
    );
  });
});

describe("durations", () => {
  it("min, h, d", () => {
    expect(formatDuration(0.25)).toBe("15 min");
    expect(formatDuration(0.001)).toBe("1 min");
    expect(formatDuration(5.4)).toBe("5 h");
    expect(formatDuration(47.6)).toBe("48 h");
    expect(formatDuration(72)).toBe("3 d");
    expect(formatDuration(100)).toBe("4 d 4 h");
  });
});

describe("where the runway is shown", () => {
  it("agent:status (activity report): text line and JSON, from the last known balance", () => {
    grant(500, 24);
    for (let h = 1; h <= 24; h++) spend(500, h - 0.5);
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 425, usdcBalance: 0 }));
    const r = getActivityReport(db.raw, NOW, undefined, D);
    expect(r.runway).toMatchObject({ balanceCents: 425, tier: "normal", burnCentsPerHour: 0.5 });
    expect(formatActivityReport(r, NOW)).toContain("Runway:            $4.25 lasts ~35 d 10 h at 0.50¢/h (inference, last 24 h); low_compute at $0.50 in ~31 d 6 h");
    expect(JSON.parse(JSON.stringify(r)).runway.zeroHours).toBe(850);
  });

  it("agent:status before any balance read: unknown", () => {
    expect(getActivityReport(db.raw, NOW).runwayText).toBe("Runway: unknown (no balance read yet)");
  });

  it("the wake-up status carries the runway; an unreadable balance gives 'unknown'", () => {
    grant(500, 2);
    spend(1000, 1);
    const fin = (status: string): FinancialState => ({
      creditsCents: 499, balanceCents: 499, usdcBalance: 0, lastChecked: NOW.toISOString(), walletUsdcCents: 0, ledgerCents: 499,
      balanceStatus: status as any, balanceSource: "own", network: "Base Sepolia (testnet)",
    });
    const live = buildStatusSnapshot({ config: createTestConfig(), financial: fin("live"), db });
    expect(live).toMatch(/\nRunway: \$4\.99 lasts ~/);
    const down = buildStatusSnapshot({ config: createTestConfig(), financial: fin("unavailable"), db });
    expect(down).toContain("Runway: unknown (balance could not be read)");
    expect(runwayLine(db.raw, { creditsCents: 0, balanceStatus: "unavailable" }, D)).toBe("Runway: unknown (balance could not be read)");
  });
});
