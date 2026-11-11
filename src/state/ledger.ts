/**
 * Local Ledger (fork change 3)
 *
 * Append-only record of OFF-CHAIN money in USD cents:
 * owner grants, real inference costs, hosting costs and (from Phase 5a) Stripe
 * revenue, fees and refunds. On-chain USDC is read live from the wallet and is
 * never entered here, so the two never double count.
 *
 * The agent has no tool that writes here. Writers are code paths only:
 * the inference budget tracker, the owner CLI and (later) the Stripe webhook.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

export type LedgerKind =
  | "owner_grant"
  | "owner_withdrawal"
  | "inference_cost"
  | "hosting_cost"
  | "stripe_revenue"
  | "stripe_fee"
  | "stripe_refund"
  | "adjustment";

export interface LedgerEntryInput {
  kind: LedgerKind;
  /** Signed: + adds to the balance, − subtracts. The schema enforces the sign per kind. */
  amountCents: number;
  /** true = real money, false = test money (e.g. Stripe test mode). */
  livemode: boolean;
  source: string;
  externalId?: string | null;
  memo?: string;
  currency?: string;
  occurredAt?: string;
}

export interface LedgerEntry extends Required<Omit<LedgerEntryInput, "externalId">> {
  id: string;
  externalId: string | null;
  recordedAt: string;
}

/** The only currency counted in balances for now (ROADMAP 5a: EUR decision pending). */
export const LEDGER_BALANCE_CURRENCY = "USD";

function toSqlTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
}

/**
 * Append an entry. Returns false (no-op) if an entry with the same
 * (source, externalId) already exists, so replays are harmless.
 */
export function insertLedgerEntry(db: Database, entry: LedgerEntryInput): boolean {
  if (!Number.isInteger(entry.amountCents)) {
    throw new Error(`Ledger amount must be whole cents: ${entry.amountCents}`);
  }
  const result = db
    .prepare(
      `INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, currency, livemode, source, external_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO NOTHING`,
    )
    .run(
      ulid(),
      toSqlTime(entry.occurredAt ?? new Date().toISOString()),
      entry.kind,
      entry.amountCents,
      (entry.currency ?? LEDGER_BALANCE_CURRENCY).toUpperCase(),
      entry.livemode ? 1 : 0,
      entry.source,
      entry.externalId ?? null,
      entry.memo ?? "",
    );
  return result.changes > 0;
}

/**
 * Ledger balance in USD cents.
 * liveOnly = true (mainnet) counts real money only; false (testnet) counts all entries.
 */
export function getLedgerBalanceCents(db: Database, opts: { liveOnly: boolean }): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries
       WHERE currency = ? ${opts.liveOnly ? "AND livemode = 1" : ""}`,
    )
    .get(LEDGER_BALANCE_CURRENCY) as { total: number };
  return row.total;
}

/** Entries in other currencies are kept but not counted; callers can warn about them. */
export function getUncountedCurrencyCount(db: Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE currency <> ?")
    .get(LEDGER_BALANCE_CURRENCY) as { n: number };
  return row.n;
}

/** Total real money spent on inference, all time (positive cents). Not affected by inference_costs pruning. */
export function getLifetimeInferenceCostCents(db: Database): number {
  const row = db
    .prepare(
      "SELECT COALESCE(-SUM(amount_cents), 0) AS total FROM ledger_entries WHERE kind = 'inference_cost' AND livemode = 1",
    )
    .get() as { total: number };
  return row.total;
}

export function getLedgerTotalsByKind(db: Database): { kind: LedgerKind; totalCents: number; count: number }[] {
  return db
    .prepare(
      `SELECT kind, SUM(amount_cents) AS totalCents, COUNT(*) AS count FROM ledger_entries
       WHERE currency = ? GROUP BY kind ORDER BY kind`,
    )
    .all(LEDGER_BALANCE_CURRENCY) as { kind: LedgerKind; totalCents: number; count: number }[];
}

export function getRecentLedgerEntries(db: Database, limit = 20): LedgerEntry[] {
  const rows = db
    .prepare("SELECT * FROM ledger_entries ORDER BY recorded_at DESC, id DESC LIMIT ?")
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    kind: r.kind,
    amountCents: r.amount_cents,
    currency: r.currency,
    livemode: r.livemode === 1,
    source: r.source,
    externalId: r.external_id,
    memo: r.memo,
  }));
}
