/**
 * Local Ledger (fork change 3)
 *
 * Append-only record of OFF-CHAIN money in USD cents (exact: millicents, see MC_PER_CENT):
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

/**
 * Sub-cent amounts (fork, fix 6): millicents, 1 mc = 1/1000 cent = $0.00001.
 * Rows written before schema V14 have no amount_mc; they count as
 * amount_cents × 1000. Rows with amount_mc keep amount_cents = amount_mc
 * rounded away from zero (whole cents), so the cents column never shows less
 * than the real amount.
 */
export const MC_PER_CENT = 1000;
const MC_SQL = "COALESCE(amount_mc, amount_cents * 1000)";

/** Whole cents for a millicent amount, rounded away from zero. */
export function centsAwayFromZero(mc: number): number {
  const c = Math.ceil(Math.abs(mc) / MC_PER_CENT);
  return mc < 0 ? -c : c;
}

/** "$0.00312" for sub-cent amounts, "$5.00" for whole cents. */
export function formatUsdMc(mc: number): string {
  const sign = mc < 0 ? "-" : "";
  const abs = Math.abs(mc);
  const dollars = abs / (100 * MC_PER_CENT);
  return `${sign}$${abs % MC_PER_CENT === 0 ? dollars.toFixed(2) : dollars.toFixed(5)}`;
}

export interface LedgerEntryInput {
  kind: LedgerKind;
  /** Signed: + adds to the balance, − subtracts. The schema enforces the sign per kind. */
  amountCents: number;
  /**
   * Optional exact amount in millicents (same sign). When given, amountCents
   * must be amountMc rounded away from zero.
   */
  amountMc?: number;
  /** true = real money, false = test money (e.g. Stripe test mode). */
  livemode: boolean;
  source: string;
  externalId?: string | null;
  memo?: string;
  currency?: string;
  occurredAt?: string;
}

export interface LedgerEntry extends Required<Omit<LedgerEntryInput, "externalId" | "amountMc">> {
  id: string;
  externalId: string | null;
  recordedAt: string;
  /** Exact amount in millicents (amount_cents × 1000 for older rows). */
  amountMc: number;
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
  if (entry.amountMc !== undefined) {
    if (!Number.isInteger(entry.amountMc) || entry.amountMc === 0) {
      throw new Error(`Ledger amountMc must be a non-zero whole number of millicents: ${entry.amountMc}`);
    }
    if (centsAwayFromZero(entry.amountMc) !== entry.amountCents) {
      throw new Error(
        `Ledger amountCents (${entry.amountCents}) must be amountMc (${entry.amountMc}) rounded away from zero`,
      );
    }
  }
  const result = db
    .prepare(
      `INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, amount_mc, currency, livemode, source, external_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO NOTHING`,
    )
    .run(
      ulid(),
      toSqlTime(entry.occurredAt ?? new Date().toISOString()),
      entry.kind,
      entry.amountCents,
      entry.amountMc ?? entry.amountCents * MC_PER_CENT,
      (entry.currency ?? LEDGER_BALANCE_CURRENCY).toUpperCase(),
      entry.livemode ? 1 : 0,
      entry.source,
      entry.externalId ?? null,
      entry.memo ?? "",
    );
  return result.changes > 0;
}

/**
 * Ledger balance in USD millicents (exact).
 * liveOnly = true (mainnet) counts real money only; false (testnet) counts all entries.
 */
export function getLedgerBalanceMc(db: Database, opts: { liveOnly: boolean }): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${MC_SQL}), 0) AS total FROM ledger_entries
       WHERE currency = ? ${opts.liveOnly ? "AND livemode = 1" : ""}`,
    )
    .get(LEDGER_BALANCE_CURRENCY) as { total: number };
  return row.total;
}

/** Ledger balance in whole USD cents, rounded DOWN (never more than the real balance). */
export function getLedgerBalanceCents(db: Database, opts: { liveOnly: boolean }): number {
  return Math.floor(getLedgerBalanceMc(db, opts) / MC_PER_CENT);
}

/** Entries in other currencies are kept but not counted; callers can warn about them. */
export function getUncountedCurrencyCount(db: Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE currency <> ?")
    .get(LEDGER_BALANCE_CURRENCY) as { n: number };
  return row.n;
}

/** Total real money spent on inference, all time (positive millicents). Not affected by inference_costs pruning. */
export function getLifetimeInferenceCostMc(db: Database): number {
  const row = db
    .prepare(
      `SELECT COALESCE(-SUM(${MC_SQL}), 0) AS total FROM ledger_entries WHERE kind = 'inference_cost' AND livemode = 1`,
    )
    .get() as { total: number };
  return row.total;
}

/** Lifetime inference spend in whole cents, rounded UP (never less than the real spend). */
export function getLifetimeInferenceCostCents(db: Database): number {
  return Math.ceil(getLifetimeInferenceCostMc(db) / MC_PER_CENT);
}

/**
 * Inference spend (all entries, test and real) since an ISO time, positive
 * millicents. Fork: owner activity report (`--activity`, pnpm agent:status).
 */
export function getInferenceCostSinceMc(db: Database, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(-SUM(${MC_SQL}), 0) AS total FROM ledger_entries
       WHERE kind = 'inference_cost' AND occurred_at >= ?`,
    )
    .get(toSqlTime(sinceIso)) as { total: number };
  return row.total;
}

export function getLedgerTotalsByKind(db: Database): { kind: LedgerKind; totalCents: number; totalMc: number; count: number }[] {
  const rows = db
    .prepare(
      `SELECT kind, SUM(${MC_SQL}) AS totalMc, COUNT(*) AS count FROM ledger_entries
       WHERE currency = ? GROUP BY kind ORDER BY kind`,
    )
    .all(LEDGER_BALANCE_CURRENCY) as { kind: LedgerKind; totalMc: number; count: number }[];
  return rows.map((r) => ({ ...r, totalCents: centsAwayFromZero(r.totalMc) }));
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
    amountMc: r.amount_mc ?? r.amount_cents * MC_PER_CENT,
    currency: r.currency,
    livemode: r.livemode === 1,
    source: r.source,
    externalId: r.external_id,
    memo: r.memo,
  }));
}
