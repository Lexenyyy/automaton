/**
 * Owner activity report (fork, Phase 1): what the agent did recently, read
 * from state.db only. Used by `automaton --activity` and `pnpm agent:status`,
 * so a runtime that is running unnoticed shows up in its turns and spend.
 * Read-only: no model call, no network, no secrets.
 */

import type { Database } from "better-sqlite3";
import { formatUsdMc, getInferenceCostSinceMc, getLifetimeInferenceCostMc } from "./ledger.js";
import { computeRunway, formatRunway, type Runway } from "../survival/runway.js";
import { DEFAULT_SURVIVAL_SETTINGS, type SurvivalThresholds } from "../survival/settings.js";
import { buildDeadNotice, type DeadNotice } from "../survival/dead-notice.js";

export interface ActivityReport {
  agentState: string;
  lastTurnAt: string | null;
  turnsLastHour: number;
  spendLastHourMc: number;
  spendTodayMc: number;
  spendLifetimeMc: number;
  sleepUntil: string | null;
  sleepReason: string | null;
  lastWakeEnd: string | null;
  budgetPauseUntil: string | null;
  budgetPauseReason: string | null;
  /** Survival tier at the last heartbeat tick. */
  tier: string | null;
  /** Turns since the current (or last) wake cycle started. */
  turnsThisWake: number;
  wakeStartedAt: string | null;
  /** Fork (run 5, F6): wakes in a row that ended offline (model API unreachable); 0 once a call succeeds. */
  offlineStreak: number;
  /** Totals since a given time (the watchdog's start), when asked for. */
  since?: SinceStats;
  /**
   * Fork (Phase 4 step 4): runway from the last known balance (kv last_known_balance)
   * and the owner's thresholds; null when no balance was read yet.
   */
  runway: Runway | null;
  runwayText: string;
  /** Fork (Phase 4 step 5): the owner notice while the agent is dead (null otherwise). */
  deadNotice: DeadNotice | { text: string } | null;
}

export interface SinceStats {
  since: string;
  turns: number;
  spendMc: number;
  /** The tool with the most policy denials since then. */
  maxDenials: { tool: string; count: number } | null;
  /** Ledger entries other than inference cost (grants, transfers, revenue ...). */
  otherLedgerEntries: number;
}

function kv(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** SQLite datetime('now') format, for columns written that way. */
const sqlTime = (iso: string) => iso.replace("T", " ").replace(/(\.\d+)?Z$/, "");

function sinceStats(db: Database, since: string): SinceStats {
  const turns = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE timestamp >= ?").get(since) as { n: number };
  const denial = db
    .prepare(
      `SELECT tool_name AS tool, COUNT(*) AS count FROM policy_decisions
       WHERE decision <> 'allow' AND created_at >= ? GROUP BY tool_name ORDER BY count DESC LIMIT 1`,
    )
    .get(sqlTime(since)) as { tool: string; count: number } | undefined;
  const other = db
    .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind <> 'inference_cost' AND occurred_at >= ?")
    .get(sqlTime(since)) as { n: number };
  return {
    since,
    turns: turns.n,
    spendMc: getInferenceCostSinceMc(db, since),
    maxDenials: denial ?? null,
    otherLedgerEntries: other.n,
  };
}

function lastKnownBalanceCents(db: Database): number | null {
  try {
    const v = JSON.parse(kv(db, "last_known_balance") ?? "null");
    return v && Number.isFinite(v.creditsCents) ? Number(v.creditsCents) : null;
  } catch {
    return null;
  }
}

export function getActivityReport(
  db: Database,
  now: Date = new Date(),
  since?: string,
  thresholds: SurvivalThresholds = DEFAULT_SURVIVAL_SETTINGS,
): ActivityReport {
  const balance = lastKnownBalanceCents(db);
  const runway = balance === null ? null : computeRunway(db, balance, thresholds, now);
  const dead = kv(db, "agent_state") === "dead";
  const deadNotice = !dead
    ? null
    : buildDeadNotice(db, thresholds, { balanceCents: balance }) ??
      { text: "DEAD (no notice recorded yet: the heartbeat writes it on its next tick). No model calls until funded." };
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const last = db.prepare("SELECT MAX(timestamp) AS t FROM turns").get() as { t: string | null };
  const recent = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE timestamp >= ?").get(hourAgo) as { n: number };
  const wakeStart = kv(db, "wake_cycle_started_at");
  const thisWake = wakeStart
    ? (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE timestamp >= ?").get(wakeStart) as { n: number }).n
    : 0;
  return {
    deadNotice,
    runway,
    runwayText: runway ? formatRunway(runway) : "Runway: unknown (no balance read yet)",
    tier: kv(db, "last_tick_tier"),
    turnsThisWake: thisWake,
    wakeStartedAt: wakeStart,
    offlineStreak: Math.max(0, Number.parseInt(kv(db, "offline_streak") ?? "0", 10) || 0),
    ...(since ? { since: sinceStats(db, since) } : {}),
    agentState: kv(db, "agent_state") ?? "unknown",
    lastTurnAt: last.t,
    turnsLastHour: recent.n,
    spendLastHourMc: getInferenceCostSinceMc(db, hourAgo),
    spendTodayMc: getInferenceCostSinceMc(db, dayStart),
    spendLifetimeMc: getLifetimeInferenceCostMc(db),
    sleepUntil: kv(db, "sleep_until"),
    sleepReason: kv(db, "sleep_reason"),
    lastWakeEnd: kv(db, "last_wake_end"),
    budgetPauseUntil: kv(db, "inference.budget_pause_until"),
    budgetPauseReason: kv(db, "inference.budget_pause_reason"),
  };
}

function ago(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const future = ms < 0;
  const min = Math.round(Math.abs(ms) / 60_000);
  const text = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  return future ? `in ${text}` : `${text} ago`;
}

const isFuture = (iso: string | null, now: Date): iso is string =>
  iso !== null && new Date(iso).getTime() > now.getTime();

export function formatActivityReport(r: ActivityReport, now: Date = new Date()): string {
  const lines = [
    "=== AGENT ACTIVITY (state.db) ===",
    ...(r.deadNotice ? [`!!! ${r.deadNotice.text}`] : []),
    `State:             ${r.agentState}`,
    `Last turn:         ${r.lastTurnAt ? `${r.lastTurnAt} (${ago(r.lastTurnAt, now)})` : "none"}`,
    `Survival tier:     ${r.tier ?? "unknown"}`,
    `Runway:            ${r.runwayText.replace(/^Runway: /, "")}`,
    `Turns, last hour:  ${r.turnsLastHour} (this or last wake: ${r.turnsThisWake})`,
    `Inference spend:   last hour ${formatUsdMc(r.spendLastHourMc)}, today (UTC) ${formatUsdMc(r.spendTodayMc)}, lifetime real money ${formatUsdMc(r.spendLifetimeMc)}`,
  ];
  if (isFuture(r.sleepUntil, now)) {
    lines.push(`Sleeping until:    ${r.sleepUntil} (${ago(r.sleepUntil, now)})${r.sleepReason ? `: ${r.sleepReason}` : ""}`);
  }
  if (r.lastWakeEnd) {
    try {
      const w = JSON.parse(r.lastWakeEnd) as { reason?: string; at?: string };
      lines.push(`Last wake ended:   ${w.reason ?? "?"}${w.at ? ` (${w.at})` : ""}`);
    } catch {
      // ignore a malformed value
    }
  }
  if (r.offlineStreak > 0) {
    lines.push(`Offline:           the last ${r.offlineStreak} wake(s) in a row could not reach the model API`);
  }
  if (isFuture(r.budgetPauseUntil, now)) {
    lines.push(`Budget pause:      until ${r.budgetPauseUntil}${r.budgetPauseReason ? `: ${r.budgetPauseReason}` : ""}`);
  }
  lines.push("=================================");
  return lines.join("\n");
}
