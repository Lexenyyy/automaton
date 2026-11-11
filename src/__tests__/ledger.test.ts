/**
 * Fork change 3: local ledger (append-only, off-chain money only).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6, MIGRATION_V12 } from "../state/schema.js";
import {
  insertLedgerEntry,
  getLedgerBalanceCents,
  getLifetimeInferenceCostCents,
  getUncountedCurrencyCount,
  getLedgerTotalsByKind,
} from "../state/ledger.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { inferenceInsertCost, inferencePruneCosts } from "../state/database.js";
import { createTestDb as createFullTestDb } from "./mocks.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  db.exec(MIGRATION_V12);
});

afterEach(() => db.close());

const grant = (cents: number, livemode = true) =>
  insertLedgerEntry(db, { kind: "owner_grant", amountCents: cents, livemode, source: "owner_cli" });

describe("ledger_entries", () => {
  it("is created by the real migration chain", () => {
    const full = createFullTestDb();
    expect(() => insertLedgerEntry(full.raw, { kind: "owner_grant", amountCents: 1, livemode: true, source: "t" })).not.toThrow();
    full.close();
  });

  it("is append-only: UPDATE and DELETE fail", () => {
    grant(500);
    expect(() => db.exec("UPDATE ledger_entries SET amount_cents = 999999")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM ledger_entries")).toThrow(/append-only/);
    expect(getLedgerBalanceCents(db, { liveOnly: false })).toBe(500);
  });

  it("enforces the sign per kind", () => {
    expect(() => insertLedgerEntry(db, { kind: "owner_grant", amountCents: -5, livemode: true, source: "x" })).toThrow();
    expect(() => insertLedgerEntry(db, { kind: "inference_cost", amountCents: 5, livemode: true, source: "x" })).toThrow();
    expect(() => insertLedgerEntry(db, { kind: "stripe_revenue", amountCents: -1, livemode: false, source: "x" })).toThrow();
    expect(() => insertLedgerEntry(db, { kind: "stripe_fee", amountCents: 3, livemode: false, source: "x" })).toThrow();
    expect(() => insertLedgerEntry(db, { kind: "adjustment", amountCents: 0, livemode: true, source: "x" })).toThrow();
    expect(() => insertLedgerEntry(db, { kind: "adjustment", amountCents: -7, livemode: true, source: "x", memo: "fix" })).not.toThrow();
  });

  it("rejects fractional cents", () => {
    expect(() => insertLedgerEntry(db, { kind: "owner_grant", amountCents: 1.5, livemode: true, source: "x" })).toThrow(/whole cents/);
  });

  it("(source, external_id) makes replays a no-op", () => {
    const e = { kind: "stripe_revenue" as const, amountCents: 1000, livemode: false, source: "stripe_webhook", externalId: "evt_1" };
    expect(insertLedgerEntry(db, e)).toBe(true);
    expect(insertLedgerEntry(db, e)).toBe(false);
    expect(getLedgerBalanceCents(db, { liveOnly: false })).toBe(1000);
  });

  it("testnet counts all entries; mainnet counts only real money", () => {
    grant(500, true);
    insertLedgerEntry(db, { kind: "stripe_revenue", amountCents: 2000, livemode: false, source: "stripe_webhook", externalId: "evt_test" });
    expect(getLedgerBalanceCents(db, { liveOnly: false })).toBe(2500);
    expect(getLedgerBalanceCents(db, { liveOnly: true })).toBe(500);
  });

  it("only USD is counted; other currencies are kept and reported", () => {
    grant(500);
    insertLedgerEntry(db, { kind: "stripe_revenue", amountCents: 1000, currency: "eur", livemode: false, source: "stripe_webhook", externalId: "evt_eur" });
    expect(getLedgerBalanceCents(db, { liveOnly: false })).toBe(500);
    expect(getUncountedCurrencyCount(db)).toBe(1);
    expect(getLedgerTotalsByKind(db).map((t) => t.kind)).toEqual(["owner_grant"]);
  });
});

describe("inference costs go to the ledger", () => {
  const cost = (cents: number) => ({
    sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai",
    inputTokens: 1000, outputTokens: 500, costCents: cents, latencyMs: 10,
    tier: "normal", taskType: "agent_turn", cacheHit: false,
  });

  it("recordCost writes exactly one real-money debit per paid call", () => {
    const tracker = new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG);
    tracker.recordCost(cost(3));
    tracker.recordCost(cost(2));
    tracker.recordCost(cost(0)); // free model: no ledger row
    expect(getLifetimeInferenceCostCents(db)).toBe(5);
    expect(getLedgerBalanceCents(db, { liveOnly: true })).toBe(-5);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it("lifetime cost survives inference_costs pruning", () => {
    const tracker = new InferenceBudgetTracker(db, DEFAULT_MODEL_STRATEGY_CONFIG);
    tracker.recordCost(cost(4));
    db.exec("UPDATE inference_costs SET created_at = '2000-01-01 00:00:00'");
    expect(inferencePruneCosts(db, 1)).toBe(1);
    expect(getLifetimeInferenceCostCents(db)).toBe(4);
  });

  it("the migration backfills earlier inference costs", () => {
    const fresh = new Database(":memory:");
    fresh.exec(MIGRATION_V6);
    inferenceInsertCost(fresh, cost(7));
    inferenceInsertCost(fresh, cost(0));
    fresh.exec(MIGRATION_V12);
    expect(getLifetimeInferenceCostCents(fresh)).toBe(7);
    fresh.close();
  });
});
