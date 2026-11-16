/**
 * Sub-cent accounting in millicents (fork, fix 6): exact per-call costs,
 * rounded up per call (never undercounts), caps compared exactly, balance
 * rounded down, older whole-cent rows still counted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATION_V6, MIGRATION_V12, SCHEMA_VERSION, applyMigrationV14 } from "../state/schema.js";
import {
  centsAwayFromZero,
  formatUsdMc,
  getLedgerBalanceCents,
  getLedgerBalanceMc,
  getLifetimeInferenceCostCents,
  getLifetimeInferenceCostMc,
  getRecentLedgerEntries,
  insertLedgerEntry,
} from "../state/ledger.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { costMcCeil } from "../inference/metered-client.js";
import { costMcFromPer1k } from "../inference/router.js";
import { createDatabase } from "../state/database.js";
import { runLedgerCommand } from "../state/ledger-command.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  db.exec(MIGRATION_V12);
  applyMigrationV14(db);
});
afterEach(() => db.close());

const call = (costMc: number) => ({
  sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai",
  inputTokens: 1, outputTokens: 1, costCents: Math.ceil(costMc / 1000), costMc,
  latencyMs: 1, tier: "normal", taskType: "agent_turn" as const, cacheHit: false,
});

describe("cost in millicents", () => {
  it("prices per call, rounded up to whole millicents", () => {
    // gpt-4.1-mini: $0.40 / $1.60 per 1M tokens. 10k in + 200 out = 0.4c + 0.032c = 432 mc.
    expect(costMcCeil(10_000, 200, { input: 0.4, output: 1.6 })).toBe(432);
    // A fraction of a millicent rounds up, never down.
    expect(costMcCeil(1, 0, { input: 0.4, output: 1.6 })).toBe(1);
    expect(costMcCeil(0, 0, { input: 0.4, output: 1.6 })).toBe(0);
    // Router units: costPer1k in hundredths of a cent per 1k tokens (gpt-4.1-mini: 4 / 16).
    expect(costMcFromPer1k(10_000, 200, { costPer1kInput: 4, costPer1kOutput: 16 })).toBe(432);
  });

  it("rounds cents away from zero and formats sub-cent amounts", () => {
    expect(centsAwayFromZero(312)).toBe(1);
    expect(centsAwayFromZero(-312)).toBe(-1);
    expect(centsAwayFromZero(-2000)).toBe(-2);
    expect(formatUsdMc(500_000)).toBe("$5.00");
    expect(formatUsdMc(-312)).toBe("-$0.00312");
  });
});

describe("ledger and caps with sub-cent costs", () => {
  it("three 0.312c calls cost 0.936c, not 3c; the cents column is still rounded up", () => {
    const t = new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG);
    for (let i = 0; i < 3; i++) t.recordCost(call(312));
    expect(getLifetimeInferenceCostMc(db)).toBe(936);
    expect(getLifetimeInferenceCostCents(db)).toBe(1);
    expect(t.getDailyCostMc()).toBe(936);
    expect(t.getDailyCost()).toBe(1);
    const rows = db.prepare("SELECT cost_cents, cost_mc FROM inference_costs").all();
    expect(rows).toEqual([{ cost_cents: 1, cost_mc: 312 }, { cost_cents: 1, cost_mc: 312 }, { cost_cents: 1, cost_mc: 312 }]);
    const e = getRecentLedgerEntries(db, 1)[0];
    expect(e).toMatchObject({ kind: "inference_cost", amountCents: -1, amountMc: -312 });
  });

  it("balance is exact in millicents and rounded DOWN in cents", () => {
    insertLedgerEntry(db, { kind: "owner_grant", amountCents: 500, livemode: true, source: "owner_cli" });
    new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG).recordCost(call(312));
    expect(getLedgerBalanceMc(db, { liveOnly: true })).toBe(499_688);
    expect(getLedgerBalanceCents(db, { liveOnly: true })).toBe(499);
  });

  it("the daily cap is compared exactly", () => {
    const t = new InferenceBudgetTracker(db, { ...DEFAULT_MODEL_STRATEGY_CONFIG, dailyBudgetCents: 1, hourlyBudgetCents: 0 });
    for (let i = 0; i < 3; i++) t.recordCost(call(312)); // 936 mc of 1000
    expect(t.checkBudget(0.05, "m").allowed).toBe(true); // 986 <= 1000
    const refused = t.checkBudget(0.1, "m"); // 1036 > 1000
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("Daily inference budget exhausted: 0.936c spent + 0.1c estimated > 1c limit");
  });

  it("reservations are counted in millicents and released exactly", () => {
    const t = new InferenceBudgetTracker(db, { ...DEFAULT_MODEL_STRATEGY_CONFIG, dailyBudgetCents: 1, hourlyBudgetCents: 0 });
    const r = t.tryReserve(0.6, "m");
    expect(r.allowed).toBe(true);
    expect(t.getReservedCents()).toBeCloseTo(0.6);
    expect(t.tryReserve(0.5, "m").allowed).toBe(false); // 600 + 500 > 1000
    if (r.allowed) r.release();
    expect(t.getReservedCents()).toBe(0);
    expect(t.tryReserve(0.5, "m").allowed).toBe(true);
  });

  it("refuses inconsistent amounts", () => {
    const base = { kind: "inference_cost" as const, livemode: true, source: "x" };
    expect(() => insertLedgerEntry(db, { ...base, amountCents: -2, amountMc: -312, externalId: "a" })).toThrow(/rounded away from zero/);
    expect(() => insertLedgerEntry(db, { ...base, amountCents: -1, amountMc: -312.5, externalId: "b" })).toThrow(/whole number/);
    // The column CHECK rejects a sign that does not match amount_cents.
    expect(() =>
      db.prepare(
        "INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, amount_mc, livemode, source) VALUES ('z', '2026-01-01', 'inference_cost', -1, 312, 1, 'x')",
      ).run(),
    ).toThrow(/CHECK/);
  });

  it("owner ledger view shows the exact sub-cent amounts", () => {
    insertLedgerEntry(db, { kind: "owner_grant", amountCents: 500, livemode: true, source: "owner_cli" });
    new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG).recordCost(call(312));
    const out = runLedgerCommand(db, ["show"], { liveOnly: false }).output;
    expect(out).toContain("Balance:                 $4.99688");
    expect(out).toContain("Lifetime inference cost: $0.00312");
    expect(out).toMatch(/owner_grant\s+\$5\.00\s+\(1\)/);
    expect(out).toContain("-$0.00312");
  });
});

describe("migration V14", () => {
  it("is idempotent and leaves older rows untouched (counted as cents x 1000)", () => {
    const fresh = new Database(":memory:");
    fresh.exec(MIGRATION_V6);
    fresh.exec(MIGRATION_V12);
    insertLedgerEntryLegacy(fresh, -3);
    applyMigrationV14(fresh);
    applyMigrationV14(fresh);
    const row = fresh.prepare("SELECT amount_cents, amount_mc FROM ledger_entries").get();
    expect(row).toEqual({ amount_cents: -3, amount_mc: null });
    expect(getLedgerBalanceMc(fresh, { liveOnly: true })).toBe(-3000);
    fresh.close();
  });

  it("a new database is at schema 14 or later with both columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subcent-"));
    const full = createDatabase(path.join(dir, "state.db"));
    try {
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
      const names = (t: string) => (full.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(names("inference_costs")).toContain("cost_mc");
      expect(names("ledger_entries")).toContain("amount_mc");
    } finally {
      full.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function insertLedgerEntryLegacy(d: BetterSqlite3.Database, cents: number) {
  d.prepare(
    "INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, livemode, source) VALUES ('legacy', '2026-01-01', 'inference_cost', ?, 1, 'x')",
  ).run(cents);
}
