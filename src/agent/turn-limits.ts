/**
 * Per-wake turn cap (fork, Phase 2, owner-approved after run 5).
 *
 * Run 5's second wake used 19 turns in 30 seconds; the watchdog polls every
 * 5 minutes, so the runtime itself must end a wake after a few turns.
 * config.maxTurnsPerCycle (default 25) is that cap: the loop ends the wake as
 * "cycle limit (N turns)" with a forced sleep (loopGuard.forcedSleepMinutes).
 * Invalid values are refused at startup instead of silently ignored.
 */

import type { AutomatonConfig } from "../types.js";

export const DEFAULT_MAX_TURNS_PER_WAKE = 25;
export const MAX_TURNS_PER_WAKE_LIMIT = 100;

/** A problem with config.maxTurnsPerCycle, or null when it is valid or unset. */
export function checkMaxTurnsPerCycle(config: Pick<AutomatonConfig, "maxTurnsPerCycle">): string | null {
  const v = config.maxTurnsPerCycle;
  if (v === undefined) return null;
  if (!Number.isInteger(v) || v < 1 || v > MAX_TURNS_PER_WAKE_LIMIT) {
    return `maxTurnsPerCycle must be a whole number from 1 to ${MAX_TURNS_PER_WAKE_LIMIT} (got ${JSON.stringify(v)})`;
  }
  return null;
}

/** The cap the loop applies (the default when unset or invalid). */
export function resolveMaxTurnsPerWake(config: Pick<AutomatonConfig, "maxTurnsPerCycle">): number {
  return checkMaxTurnsPerCycle(config) === null && config.maxTurnsPerCycle !== undefined
    ? config.maxTurnsPerCycle
    : DEFAULT_MAX_TURNS_PER_WAKE;
}
