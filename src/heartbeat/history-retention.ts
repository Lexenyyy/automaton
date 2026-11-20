/**
 * Heartbeat history retention (fork, after run 6).
 *
 * Every heartbeat task run adds a row to heartbeat_history (about 1,170 a day
 * with the default schedule) and upstream never deleted any: the scheduler had
 * a pruneHistory method with no caller. config.heartbeatHistoryDays (default 7,
 * 0 = keep everything) is how long rows are kept; the scheduler prunes at most
 * once an hour. Invalid values are refused at startup.
 */

import type { AutomatonConfig } from "../types.js";

export const DEFAULT_HEARTBEAT_HISTORY_DAYS = 7;
export const MAX_HEARTBEAT_HISTORY_DAYS = 365;
/** The scheduler prunes at most this often. */
export const HEARTBEAT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** A problem with config.heartbeatHistoryDays, or null when it is valid or unset. */
export function checkHeartbeatHistoryDays(config: Pick<AutomatonConfig, "heartbeatHistoryDays">): string | null {
  const v = config.heartbeatHistoryDays;
  if (v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || v > MAX_HEARTBEAT_HISTORY_DAYS) {
    return `heartbeatHistoryDays must be a whole number from 0 (keep all) to ${MAX_HEARTBEAT_HISTORY_DAYS} (got ${JSON.stringify(v)})`;
  }
  return null;
}

/** Days of heartbeat history to keep (0 = keep all); the default when unset or invalid. */
export function resolveHeartbeatHistoryDays(config: Pick<AutomatonConfig, "heartbeatHistoryDays">): number {
  return checkHeartbeatHistoryDays(config) === null && config.heartbeatHistoryDays !== undefined
    ? config.heartbeatHistoryDays
    : DEFAULT_HEARTBEAT_HISTORY_DAYS;
}
