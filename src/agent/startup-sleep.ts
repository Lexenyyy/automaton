/**
 * Sleep across restarts (fork, Phase 1).
 *
 * Upstream, every `--run` cleared `sleep_until` and woke the agent at once,
 * so each restart cost a paid wake even when the agent (or a forced sleep:
 * loop guard, cycle limit, budget pause) had just gone to sleep for an hour.
 * Now a restart honours a `sleep_until` that is still in the future; the
 * owner wakes it immediately with `--run --wake-now`. Wake events (heartbeat,
 * inbox) still end the sleep early, as in the normal sleeping state.
 */

import type { Database } from "better-sqlite3";
import { consumeNextWakeEvent } from "../state/database.js";

export interface PendingSleep {
  untilMs: number;
  reason: string | null;
}

/** A future sleep to honour at startup, or null (none, already over, or --wake-now). */
export function pendingStartupSleep(
  getKV: (key: string) => string | undefined,
  nowMs: number,
  wakeNow: boolean,
): PendingSleep | null {
  if (wakeNow) return null;
  const raw = getKV("sleep_until");
  const untilMs = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  let reason: string | null = null;
  try {
    reason = (JSON.parse(getKV("last_wake_end") ?? "null") as { reason?: string } | null)?.reason ?? null;
  } catch {
    // ignore a malformed value
  }
  return { untilMs, reason: reason ?? getKV("sleep_reason") ?? null };
}

/**
 * Delete the wake requests still queued from before this start (they would end
 * a pending startup sleep at once). Call it BEFORE the heartbeat starts: the
 * heartbeat's first check runs at once and may queue a wake that must count
 * (a tier change seen at startup). Until 2026-11-24 this ran after
 * heartbeat.start(), and in the tier walk (drain 3) the tier-change wake was
 * deleted 20 ms after it was queued. Returns how many were deleted.
 */
export function dropStaleWakeEvents(db: Database): number {
  let dropped = 0;
  while (consumeNextWakeEvent(db)) dropped++;
  return dropped;
}

export type SleepEnd = { woken: false } | { woken: true; source: string; reason: string };

/**
 * Wait until untilMs (at least 10 s), checking for a wake event every 30 s.
 * The same wait the run loop uses for the sleeping state.
 */
export async function waitForSleepOrWake(
  db: Database,
  untilMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SleepEnd> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sleepMs = Math.max(untilMs - now(), 10_000);
  const checkInterval = Math.min(sleepMs, 30_000);
  let slept = 0;
  while (slept < sleepMs) {
    await sleep(checkInterval);
    slept += checkInterval;
    const wakeEvent = consumeNextWakeEvent(db);
    if (wakeEvent) return { woken: true, source: wakeEvent.source, reason: wakeEvent.reason };
  }
  return { woken: false };
}
