/**
 * Budget pause (fork, Phase 1)
 *
 * When an inference budget cap refuses a call, the orchestrator and local
 * workers pause until the next budget window, the same way the main loop
 * sleeps. They never mark tasks failed or replan because of a budget refusal.
 * The pause is stored in the kv table so it survives a restart.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

export const BUDGET_PAUSE_KEY = "inference.budget_pause_until";
export const BUDGET_PAUSE_REASON_KEY = "inference.budget_pause_reason";

/** Minimum pause, so a refused caller doesn't spin. */
const MIN_PAUSE_MS = 5 * 60_000;

/** Start of the next UTC hour, at least 5 minutes from now. */
export function nextBudgetWindow(now = Date.now()): number {
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(60, 0, 0);
  return Math.max(nextHour.getTime(), now + MIN_PAUSE_MS);
}

/** Pause orchestration until the next budget window. Returns the wake time (ms). */
export function pauseForBudget(db: Database, reason: string, now = Date.now()): number {
  const until = nextBudgetWindow(now);
  const existing = getBudgetPauseUntil(db, now);
  const wakeAt = existing !== null ? Math.max(existing, until) : until;
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  );
  upsert.run(BUDGET_PAUSE_KEY, new Date(wakeAt).toISOString());
  upsert.run(BUDGET_PAUSE_REASON_KEY, reason.slice(0, 500));
  return wakeAt;
}

/** Wake time (ms) if a budget pause is active, else null. */
export function getBudgetPauseUntil(db: Database, now = Date.now()): number | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(BUDGET_PAUSE_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  const until = Date.parse(row.value);
  return Number.isFinite(until) && until > now ? until : null;
}

/**
 * Put a task back to pending so it runs again after the pause, instead of
 * failing it. Only touches tasks that are still assigned or running.
 */
export function requeueTaskForBudget(db: Database, taskId: string): void {
  db.prepare(
    `UPDATE task_graph
     SET status = 'pending', assigned_to = NULL, started_at = NULL
     WHERE id = ? AND status IN ('assigned', 'running')`,
  ).run(taskId);
}
