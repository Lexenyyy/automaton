/**
 * Owner activity report (fork, Phase 1): what the agent did recently, read
 * from state.db only. Used by `automaton --activity` and `pnpm agent:status`,
 * so a runtime that is running unnoticed shows up in its turns and spend.
 * Read-only: no model call, no network, no secrets.
 */

import type { Database } from "better-sqlite3";
import { formatUsdMc, getInferenceCostSinceMc, getLifetimeInferenceCostMc } from "./ledger.js";

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
}

function kv(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getActivityReport(db: Database, now: Date = new Date()): ActivityReport {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const last = db.prepare("SELECT MAX(timestamp) AS t FROM turns").get() as { t: string | null };
  const recent = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE timestamp >= ?").get(hourAgo) as { n: number };
  return {
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
    `State:             ${r.agentState}`,
    `Last turn:         ${r.lastTurnAt ? `${r.lastTurnAt} (${ago(r.lastTurnAt, now)})` : "none"}`,
    `Turns, last hour:  ${r.turnsLastHour}`,
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
  if (isFuture(r.budgetPauseUntil, now)) {
    lines.push(`Budget pause:      until ${r.budgetPauseUntil}${r.budgetPauseReason ? `: ${r.budgetPauseReason}` : ""}`);
  }
  lines.push("=================================");
  return lines.join("\n");
}
