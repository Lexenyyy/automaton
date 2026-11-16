/**
 * Fork, Phase 1: owner activity report (`--activity`, pnpm agent:status).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./mocks.js";
import { insertLedgerEntry } from "../state/ledger.js";
import { getActivityReport, formatActivityReport } from "../state/activity-report.js";

const NOW = new Date("2026-11-16T16:30:00.000Z");

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());

const turn = (id: string, iso: string) =>
  db.raw
    .prepare("INSERT INTO turns (id, timestamp, state, thinking) VALUES (?, ?, 'running', '')")
    .run(id, iso);
const cost = (mc: number, iso: string) =>
  insertLedgerEntry(db.raw, {
    kind: "inference_cost",
    amountCents: -Math.ceil(mc / 1000),
    amountMc: -mc,
    livemode: true,
    source: "inference_router",
    occurredAt: iso,
  });

describe("activity report", () => {
  it("counts turns and inference spend for the last hour and the UTC day", () => {
    turn("a", "2026-11-15T23:00:00.000Z"); // yesterday
    turn("b", "2026-11-16T15:00:00.000Z"); // today, more than an hour ago
    turn("c", "2026-11-16T16:00:00.000Z"); // last hour
    turn("d", "2026-11-16T16:17:09.000Z"); // last hour, latest
    cost(5_000, "2026-11-15T23:00:00.000Z");
    cost(1_500, "2026-11-16T15:00:00.000Z");
    cost(820, "2026-11-16T16:10:00.000Z");
    cost(180, "2026-11-16T16:17:09.000Z");

    const r = getActivityReport(db.raw, NOW);
    expect(r.lastTurnAt).toBe("2026-11-16T16:17:09.000Z");
    expect(r.turnsLastHour).toBe(2);
    expect(r.spendLastHourMc).toBe(1_000);
    expect(r.spendTodayMc).toBe(2_500);
    expect(r.spendLifetimeMc).toBe(7_500);
  });

  it("shows state, a future sleep, the last wake end and an active budget pause", () => {
    db.setAgentState("sleeping");
    db.setKV("sleep_until", "2026-11-16T17:00:00.000Z");
    db.setKV("sleep_reason", "budget cap reached");
    db.setKV("last_wake_end", JSON.stringify({ reason: "budget cap reached", at: "2026-11-16T16:17:10.000Z" }));
    db.setKV("inference.budget_pause_until", "2026-11-16T17:00:00.000Z");
    db.setKV("inference.budget_pause_reason", "Hourly budget exhausted");

    const text = formatActivityReport(getActivityReport(db.raw, NOW), NOW);
    expect(text).toContain("State:             sleeping");
    expect(text).toContain("Last turn:         none");
    expect(text).toContain("Sleeping until:    2026-11-16T17:00:00.000Z (in 30 min): budget cap reached");
    expect(text).toContain("Last wake ended:   budget cap reached (2026-11-16T16:17:10.000Z)");
    expect(text).toContain("Budget pause:      until 2026-11-16T17:00:00.000Z: Hourly budget exhausted");
    expect(text).toContain("last hour $0.00, today (UTC) $0.00");
  });

  it("leaves out a sleep or budget pause that is already over", () => {
    db.setKV("sleep_until", "2026-11-16T16:00:00.000Z");
    db.setKV("inference.budget_pause_until", "2026-11-16T16:00:00.000Z");
    const text = formatActivityReport(getActivityReport(db.raw, NOW), NOW);
    expect(text).not.toContain("Sleeping until");
    expect(text).not.toContain("Budget pause");
  });
});
