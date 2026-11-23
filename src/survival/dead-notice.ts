/**
 * Owner notice while the agent is dead (fork, Phase 4 step 5).
 *
 * The survival watch writes one record when the agent enters dead (kv
 * dead_notice: since, reason, network, balance at entry) and logs one WARN;
 * reviving deletes it. The notice text is built when it is shown, from the
 * latest known balance: since when, the wallet address and network to fund,
 * and how much is needed to revive (balance above $0: critical) and to reach
 * normal. Only public data: the wallet address, amounts and times. No key
 * material, no passphrase, no API key, no config secrets.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SurvivalThresholds } from "./settings.js";

type Database = BetterSqlite3.Database;

export const DEAD_RECORD_KEY = "dead_notice";

export interface DeadRecord {
  since: string;
  reason: string;
  network: string;
  balanceCentsAtEntry: number;
}

export interface DeadNotice {
  since: string;
  reason: string;
  address: string | null;
  network: string;
  balanceCents: number;
  /** Cents to add so the balance is above $0 (revives the agent, tier critical); 0 = already above. */
  toReviveCents: number;
  /** Cents to add so the balance is above survival.normalCents (tier normal); 0 = already above. */
  toNormalCents: number;
  text: string;
}

const getKv = (db: Database, key: string): string | undefined =>
  (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;

export function readDeadRecord(db: Database): DeadRecord | null {
  try {
    const v = JSON.parse(getKv(db, DEAD_RECORD_KEY) ?? "null");
    return v && typeof v.since === "string" ? (v as DeadRecord) : null;
  } catch {
    return null;
  }
}

export function writeDeadRecord(db: Database, rec: DeadRecord): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(DEAD_RECORD_KEY, JSON.stringify(rec));
}

export function clearDeadRecord(db: Database): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(DEAD_RECORD_KEY);
}

/** The agent's public wallet address, as the runtime stored it (identity table). */
export function walletAddressFromDb(db: Database): string | null {
  try {
    return (db.prepare("SELECT value FROM identity WHERE key = 'address'").get() as { value: string } | undefined)?.value || null;
  } catch {
    return null;
  }
}

const usdc = (cents: number) => `${(cents / 100).toFixed(2)} USDC`;
const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Builds the notice; null when there is no dead record. */
export function buildDeadNotice(
  db: Database,
  thresholds: SurvivalThresholds,
  opts: { balanceCents?: number | null; address?: string | null } = {},
): DeadNotice | null {
  const rec = readDeadRecord(db);
  if (!rec) return null;
  const balanceCents = typeof opts.balanceCents === "number" && Number.isFinite(opts.balanceCents)
    ? opts.balanceCents
    : rec.balanceCentsAtEntry;
  const address = opts.address ?? walletAddressFromDb(db);
  const toReviveCents = Math.max(0, 1 - balanceCents);
  const toNormalCents = Math.max(0, thresholds.normalCents + 1 - balanceCents);
  const head = `DEAD since ${rec.since.slice(0, 19).replace("T", " ")} UTC (${rec.reason}). No model calls until funded. `;
  const wallet = `${address ?? "the agent's wallet (address unknown)"} on ${rec.network}`;
  const text = toReviveCents === 0
    // Already funded (e.g. a grant just added): the heartbeat leaves dead on its next live balance read.
    ? `${head}Balance now ${usd(balanceCents)} is above $0: the heartbeat revives the agent on its next live balance read ` +
      `(wallet ${wallet}${toNormalCents > 0 ? `; ${usdc(toNormalCents)} more to reach normal` : ""}).`
    : `${head}Fund ${wallet}: at least ${usdc(toReviveCents)} to revive (critical), ${usdc(toNormalCents)} to reach normal ` +
      `(balance now ${usd(balanceCents)}). Or add an owner grant: pnpm agent:ledger:grant <dollars>.`;
  return { since: rec.since, reason: rec.reason, address, network: rec.network, balanceCents, toReviveCents, toNormalCents, text };
}
