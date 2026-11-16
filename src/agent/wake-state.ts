/**
 * Wake-cycle facts for the wake-up status (fork, Phase 1).
 *
 * The restart test (run 3) redid its one-time setup on every wake: nothing
 * told it what was already done or why the last wake ended. These helpers keep
 * that in the kv table and the soul history, so the wake-up status can say it.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const WAKE_STARTED_KEY = "wake_cycle_started_at";
const LAST_WAKE_END_KEY = "last_wake_end";

function getKv(db: Database, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

function setKv(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

/** Called when a wake cycle (one runAgentLoop) starts. Returns the start time (ISO). */
export function recordWakeStart(db: Database, now = new Date()): string {
  const iso = now.toISOString();
  setKv(db, WAKE_STARTED_KEY, iso);
  return iso;
}

/** Start time (ISO) of the current wake cycle, if recorded. */
export function getWakeStart(db: Database): string | undefined {
  return getKv(db, WAKE_STARTED_KEY);
}

/** Why the wake cycle ended, e.g. "agent chose sleep" or "cycle limit (25 turns)". */
export function recordWakeEnd(db: Database, reason: string, now = new Date()): void {
  setKv(db, LAST_WAKE_END_KEY, JSON.stringify({ reason, at: now.toISOString() }));
}

export function getLastWakeEnd(db: Database): { reason: string; at: string } | undefined {
  const raw = getKv(db, LAST_WAKE_END_KEY);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return typeof v?.reason === "string" && typeof v?.at === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Latest soul version written by update_soul (soul_history), if any. */
export function getSoulState(db: Database): { version: number; updatedAt: string } | undefined {
  try {
    const row = db
      .prepare("SELECT version, created_at FROM soul_history ORDER BY version DESC LIMIT 1")
      .get() as { version: number; created_at: string } | undefined;
    return row ? { version: row.version, updatedAt: row.created_at } : undefined;
  } catch {
    return undefined;
  }
}
