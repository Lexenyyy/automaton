/**
 * Offline handling (fork, run 5 fix F6).
 *
 * When the model API cannot be reached (no internet, DNS failure, connection
 * reset, timeout), more turns cannot help: the agent cannot think, and it should
 * not act on a half-finished picture. The loop ends the wake at the first such
 * error ("offline: …") and sleeps with growing gaps: 30, 60, then 120 minutes
 * (never below sleepConfig.minSeconds). A successful model call resets the gap.
 * Other errors keep the old path (5 consecutive errors, then sleep).
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

const OFFLINE_STREAK_KEY = "offline_streak";
/** Sleep after the 1st, 2nd and 3rd+ offline wake in a row. */
export const OFFLINE_BACKOFF_MINUTES = [30, 60, 120] as const;

const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN",
  "EHOSTUNREACH", "EHOSTDOWN", "EPIPE", "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const NETWORK_NAMES = new Set([
  "AbortError", "TimeoutError", "APIConnectionError", "APIConnectionTimeoutError", "CircuitOpenError",
  "ConnectTimeoutError", "SocketError", "FetchError",
]);
const NETWORK_MESSAGE =
  /fetch failed|getaddrinfo|socket hang up|network (error|is unreachable)|connection (error|refused|reset)|request timed out|operation was aborted|circuit (breaker )?open/i;

/** True when the error (or one of its causes) means the network or the provider host is unreachable. */
export function isNetworkError(err: unknown): boolean {
  let e: any = err;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause) {
    if (typeof e === "object") {
      if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
      if (typeof e.name === "string" && NETWORK_NAMES.has(e.name)) return true;
      if (typeof e.message === "string" && NETWORK_MESSAGE.test(e.message)) return true;
    } else if (typeof e === "string") {
      return NETWORK_MESSAGE.test(e);
    }
  }
  return false;
}

/** A short, key-free description of a network error for logs and the wake-end reason. */
export function describeNetworkError(err: unknown): string {
  const parts: string[] = [];
  let e: any = err;
  for (let depth = 0; e && depth < 3; depth++, e = e.cause) {
    const bit = typeof e === "object" ? (e.code || e.message || e.name) : String(e);
    if (bit && !parts.includes(String(bit))) parts.push(String(bit));
  }
  return (parts.join(": ") || "unknown network error").replace(/\s+/g, " ").slice(0, 120);
}

export function getOfflineStreak(db: Database): number {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(OFFLINE_STREAK_KEY) as { value: string } | undefined;
  const n = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Counts one more offline wake in a row; returns the new streak. */
export function recordOfflineWake(db: Database): number {
  const n = getOfflineStreak(db) + 1;
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(OFFLINE_STREAK_KEY, String(n));
  return n;
}

/** After a successful model call. */
export function clearOfflineStreak(db: Database): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(OFFLINE_STREAK_KEY);
}

/** Sleep after the n-th offline wake in a row (30, 60, 120, 120 … min), never below the sleep floor. */
export function offlineBackoffMs(streak: number, minSeconds: number): number {
  const i = Math.min(Math.max(streak, 1), OFFLINE_BACKOFF_MINUTES.length) - 1;
  return Math.max(OFFLINE_BACKOFF_MINUTES[i] * 60_000, minSeconds * 1000);
}
