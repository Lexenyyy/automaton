/**
 * Sleep floor and daily wake cap (fork, Phase 2 prep, owner-approved).
 *
 * Nothing limited how short a sleep the agent picked: `sleep(0)` ended the
 * wake and the runtime woke it again 10 s later (about 240 wakes an hour,
 * stopped only by the hourly and daily money caps). Two owner settings,
 * enforced in code (config is read-only to the agent):
 *   - sleepConfig.minSeconds: no sleep is shorter. Applied in the one place
 *     every sleep goes through (the runtime's sleeping state), and announced
 *     by the sleep tool so the agent knows the real wake time.
 *   - sleepConfig.maxWakesPerDay: wake cycles per UTC day (restarts and
 *     heartbeat wake-ups count too). Past it, the agent sleeps until the next
 *     UTC day without a model call.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";

type Database = BetterSqlite3.Database;

export interface SleepSettings {
  /** Minimum length of any sleep, seconds (10..86400). */
  minSeconds: number;
  /** Wake cycles per UTC day; 0 = no limit. */
  maxWakesPerDay: number;
}

export const DEFAULT_SLEEP_SETTINGS: SleepSettings = { minSeconds: 300, maxWakesPerDay: 48 };

const WAKE_COUNT_KEY = "wake_count_day";

/** Owner settings from config.sleepConfig; invalid values fall back to the defaults. */
export function resolveSleepSettings(config: Pick<AutomatonConfig, "sleepConfig">): SleepSettings {
  const raw = config.sleepConfig ?? {};
  const minSeconds =
    typeof raw.minSeconds === "number" && Number.isFinite(raw.minSeconds) && raw.minSeconds >= 10 && raw.minSeconds <= 86_400
      ? raw.minSeconds
      : DEFAULT_SLEEP_SETTINGS.minSeconds;
  const maxWakesPerDay =
    Number.isInteger(raw.maxWakesPerDay) && (raw.maxWakesPerDay as number) >= 0 && (raw.maxWakesPerDay as number) <= 10_000
      ? (raw.maxWakesPerDay as number)
      : DEFAULT_SLEEP_SETTINGS.maxWakesPerDay;
  return { minSeconds, maxWakesPerDay };
}

/**
 * The sleep tool's duration: rejects non-numbers, zero and negatives (null),
 * raises anything shorter than the floor to the floor.
 */
export function clampSleepSeconds(requested: unknown, settings: SleepSettings): { seconds: number; raised: boolean } | null {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return null;
  const capped = Math.min(requested, 30 * 86_400);
  return capped < settings.minSeconds
    ? { seconds: settings.minSeconds, raised: true }
    : { seconds: capped, raised: false };
}

/** When a sleep that should end at untilMs really ends: never before now + floor. */
export function effectiveSleepUntil(untilMs: number, nowMs: number, settings: SleepSettings): number {
  const floor = nowMs + settings.minSeconds * 1000;
  return Number.isFinite(untilMs) && untilMs > floor ? untilMs : floor;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Wake cycles started today (UTC). */
export function getWakesToday(db: Database, now: Date = new Date()): number {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(WAKE_COUNT_KEY) as { value: string } | undefined;
  try {
    const v = row ? (JSON.parse(row.value) as { day?: string; count?: number }) : null;
    return v?.day === utcDay(now) && Number.isInteger(v.count) ? (v.count as number) : 0;
  } catch {
    return 0;
  }
}

/**
 * Called when a wake cycle starts. Counts it and returns allowed = true, or
 * allowed = false (not counted) when today's limit is already reached.
 */
export function admitWake(
  db: Database,
  settings: SleepSettings,
  now: Date = new Date(),
): { allowed: boolean; count: number } {
  return db
    .transaction(() => {
      const count = getWakesToday(db, now);
      if (settings.maxWakesPerDay > 0 && count >= settings.maxWakesPerDay) return { allowed: false, count };
      db.prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(WAKE_COUNT_KEY, JSON.stringify({ day: utcDay(now), count: count + 1 }));
      return { allowed: true, count: count + 1 };
    })
    .immediate();
}
