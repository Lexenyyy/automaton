/**
 * Survival tier watch (fork, Phase 4 step 3; findings F1–F3 of the tier audit).
 *
 * Runs on EVERY heartbeat tick (the scheduler calls it; it is not a scheduled
 * task, so it adds no heartbeat history rows). Upstream did this in the
 * check_credits task, which runs every 6 hours, and woke the agent on every
 * 15-minute ping while critical or dead.
 *
 *   - Entering dead: balance below $0 (tier "dead"), or at <= $0 for
 *     survival.deadGraceMinutes. The agent state becomes "dead"; nothing wakes
 *     the agent (no model call happens in dead: the run loop waits, see
 *     dead-state.ts, and the agent loop refuses to run).
 *   - Leaving dead: only here, only when the balance is ABOVE $0 again. The
 *     state becomes "sleeping" and the run loop resumes.
 *   - Only a live balance read counts: an unavailable or cached (failed) read
 *     changes nothing (no timer, no dead in/out, no tier change).
 *   - Every tier change (the effective tier: "dead" while the state is dead,
 *     otherwise the balance tier) is appended to kv survival_tier_changes
 *     (last 100) and logged as INFO with old tier, new tier and balance.
 *   - Tier-change wakes: one wake per change, never a change into dead, and at
 *     most one per survival.tierWakeMinGapMinutes (a balance bouncing across a
 *     boundary is recorded every time but does not cause a wake storm).
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SurvivalTier } from "../types.js";
import type { SurvivalSettings } from "./settings.js";
import { createLogger } from "../observability/logger.js";
import { getActiveNetwork } from "../identity/network.js";
import { buildDeadNotice, clearDeadRecord, readDeadRecord, writeDeadRecord } from "./dead-notice.js";

type Database = BetterSqlite3.Database;

const logger = createLogger("survival");

export const TIER_KEY = "survival_tier";
export const TIER_CHANGES_KEY = "survival_tier_changes";
export const LAST_TIER_WAKE_KEY = "last_tier_wake_at";
export const ZERO_SINCE_KEY = "zero_credits_since";
export const MAX_TIER_CHANGES = 100;
/** Fork (after the tier walk): the tier of the agent's last turn the model answered (set by the agent loop). */
export const AGENT_TURN_TIER_KEY = "agent_turn_tier";

export interface TierChange {
  at: string;
  from: SurvivalTier;
  to: SurvivalTier;
  balanceCents: number;
  woke: boolean;
  note: string;
}

export interface SurvivalTickInput {
  balanceCents: number;
  balanceStatus: string;
  /** The tier from the balance alone (getSurvivalTier with the owner's thresholds). */
  balanceTier: SurvivalTier;
}

export interface SurvivalTickResult {
  /** Effective tier after this tick ("dead" while the agent state is dead). */
  tier: SurvivalTier;
  change?: TierChange;
  enteredDead?: boolean;
  leftDead?: boolean;
  /** Set when the agent should be woken for this tier change. */
  wakeReason?: string;
}

const getKv = (db: Database, key: string): string | undefined =>
  (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const setKv = (db: Database, key: string, value: string): void => {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
};
const delKv = (db: Database, key: string): void => {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
};
const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** The agent loop records the tier of each turn the model answered (it saw that tier in its status). */
export function recordAgentTurnTier(db: Database, tier: SurvivalTier): void {
  setKv(db, AGENT_TURN_TIER_KEY, tier);
}

/**
 * Fork (after the tier walk): a tier-change wake request that tells the agent
 * nothing new. In drain 1 the heartbeat's first check after a restart queued
 * "high → normal" just after the starting wake had cleared the queue; that wake
 * ran in normal, slept, and the same request woke it again 30 s later.
 * A request is "already seen" when it is a tier change, its new tier is the tier
 * of the agent's last answered turn, and it is not a revival (from dead).
 * Returns a note for the log, or null (the request wakes the agent).
 */
export function tierWakeAlreadySeen(db: Database, event: { payload: string }): string | null {
  let p: { kind?: string; from?: string; to?: string };
  try {
    p = JSON.parse(event.payload || "{}");
  } catch {
    return null;
  }
  if (p?.kind !== "tier_change" || !p.to || p.from === "dead") return null;
  const seen = getKv(db, AGENT_TURN_TIER_KEY);
  if (seen !== p.to) return null;
  return `tier change ${p.from ?? "?"} → ${p.to} already seen: the agent's last turn ran in ${seen}`;
}

function lastKnownBalance(db: Database): number {
  try {
    const v = JSON.parse(getKv(db, "last_known_balance") ?? "null");
    return v && Number.isFinite(v.creditsCents) ? Number(v.creditsCents) : 0;
  } catch {
    return 0;
  }
}

export function getAgentStateRaw(db: Database): string | undefined {
  return getKv(db, "agent_state");
}

/** The recorded tier changes, oldest first. */
export function getTierChanges(db: Database): TierChange[] {
  try {
    const v = JSON.parse(getKv(db, TIER_CHANGES_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function evaluateSurvival(
  db: Database,
  input: SurvivalTickInput,
  settings: SurvivalSettings,
  opts: { now?: number; log?: (msg: string) => void; warn?: (msg: string) => void; network?: string } = {},
): SurvivalTickResult {
  const nowMs = opts.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const log = opts.log ?? ((m: string) => logger.info(m));
  const warn = opts.warn ?? ((m: string) => logger.warn(m));
  const networkLabel = () => {
    if (opts.network) return opts.network;
    try {
      return getActiveNetwork().label;
    } catch {
      return "the active network";
    }
  };
  // Fork (Phase 4 step 5): one dead record and one WARN per entry into dead.
  const recordDead = (reason: string, balanceCents: number) => {
    writeDeadRecord(db, { since: nowIso, reason, network: networkLabel(), balanceCentsAtEntry: balanceCents });
    const notice = buildDeadNotice(db, settings, { balanceCents });
    warn(notice?.text ?? `DEAD since ${nowIso} (${reason}).`);
  };
  const stateBefore = getAgentStateRaw(db);

  // Dead set elsewhere (the agent loop, on a live balance below $0) without a
  // record yet: write it and warn once. A non-live read never supplies the
  // balance (the last known one is used instead).
  if (stateBefore === "dead" && !readDeadRecord(db)) {
    recordDead("balance below $0 (seen by the agent loop)", input.balanceStatus === "live" ? input.balanceCents : lastKnownBalance(db));
  }

  // Only a live read decides anything. "unavailable" (no read, no cached value)
  // and "cached" (the read failed; the last good wallet value plus the current
  // ledger) never start or advance the dead timer, enter or leave dead, or
  // record a tier change.
  if (input.balanceStatus !== "live") {
    return { tier: stateBefore === "dead" ? "dead" : ((getKv(db, TIER_KEY) as SurvivalTier | undefined) ?? input.balanceTier) };
  }

  const result: SurvivalTickResult = { tier: input.balanceTier };

  // Dead timer: at <= $0 for the grace period.
  let graceOver = false;
  let zeroMinutes = 0;
  if (input.balanceCents <= 0) {
    const since = getKv(db, ZERO_SINCE_KEY);
    if (!since) {
      setKv(db, ZERO_SINCE_KEY, nowIso);
    } else {
      const elapsed = nowMs - new Date(since).getTime();
      zeroMinutes = Math.round(elapsed / 60_000);
      graceOver = elapsed >= settings.deadGraceMinutes * 60_000;
    }
  } else {
    delKv(db, ZERO_SINCE_KEY);
  }

  let deadNote = "";
  let revivedNote = "";
  if (stateBefore !== "dead" && (input.balanceTier === "dead" || graceOver)) {
    setKv(db, "agent_state", "dead");
    result.enteredDead = true;
    deadNote = input.balanceTier === "dead" ? "balance below $0" : `${zeroMinutes} min at <= $0`;
    recordDead(deadNote, input.balanceCents); // the one WARN for this entry into dead
  } else if (stateBefore === "dead" && input.balanceCents > 0) {
    const rec = readDeadRecord(db);
    setKv(db, "agent_state", "sleeping");
    delKv(db, "sleep_until");
    clearDeadRecord(db);
    result.leftDead = true;
    revivedNote = `revived at ${nowIso}${rec ? ` (dead since ${rec.since})` : ""}`;
    log(`Agent state: ${revivedNote}; balance ${usd(input.balanceCents)} is above $0 again. Resuming.`);
  }

  const effective: SurvivalTier = getAgentStateRaw(db) === "dead" ? "dead" : input.balanceTier;
  result.tier = effective;
  const prev = getKv(db, TIER_KEY) as SurvivalTier | undefined;
  setKv(db, TIER_KEY, effective);
  if (!prev || prev === effective) return result; // first observation or no change

  const lastWake = getKv(db, LAST_TIER_WAKE_KEY);
  const gapOk = !lastWake || nowMs - new Date(lastWake).getTime() >= settings.tierWakeMinGapMinutes * 60_000;
  const woke = effective !== "dead" && gapOk;
  // "wake requested": the watch queues a wake; it does not see the agent wake.
  const wakeNote = woke ? "wake requested" : `no wake: within ${settings.tierWakeMinGapMinutes} min of the last tier-change wake`;
  const note = effective === "dead"
    ? `dead (${deadNote || "state dead"}): no wake, no model calls`
    : revivedNote ? `${revivedNote}; ${wakeNote}` : wakeNote;
  const change: TierChange = { at: nowIso, from: prev, to: effective, balanceCents: input.balanceCents, woke, note };
  const all = [...getTierChanges(db), change].slice(-MAX_TIER_CHANGES);
  setKv(db, TIER_CHANGES_KEY, JSON.stringify(all));
  log(`Tier change: ${prev} → ${effective} (balance ${usd(input.balanceCents)}); ${note}`);
  result.change = change;
  if (woke) {
    setKv(db, LAST_TIER_WAKE_KEY, nowIso);
    result.wakeReason = `Survival tier changed: ${prev} → ${effective} (balance ${usd(input.balanceCents)})`;
  }
  return result;
}
