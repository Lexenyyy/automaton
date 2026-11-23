/**
 * Runway estimate (fork, Phase 4 step 4).
 *
 * Burn rate = inference spend in the ledger over the last RUNWAY_WINDOW_HOURS
 * (24), divided by the hours actually covered: at least 1, at most 24, never
 * more than the time since the first ledger entry (so a fresh agent is not
 * divided by 24 hours it has not lived). Only inference counts as burn today
 * (deliberate send_usdc payments and future revenue are not extrapolated).
 *
 * From the survival balance (ledger + wallet USDC) and the owner's thresholds:
 * time until the next lower tier boundary, and until $0. No spend in the
 * window = no estimate (never "infinite"). Read-only: no model call, no network.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SurvivalTier } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getInferenceCostSinceMc, MC_PER_CENT } from "../state/ledger.js";
import type { SurvivalThresholds } from "./settings.js";

type Database = BetterSqlite3.Database;

export const RUNWAY_WINDOW_HOURS = 24;

export interface Runway {
  balanceCents: number;
  tier: SurvivalTier;
  /** Hours of history the burn rate is based on (1..24). */
  windowHours: number;
  /** Inference spend per hour, in cents (fractional). */
  burnCentsPerHour: number;
  /** The next lower tier and when the balance reaches its boundary (null: no burn, or already dead). */
  nextTier: { tier: SurvivalTier; boundaryCents: number; hours: number | null } | null;
  /** Hours until $0 (0 when already at or below $0; null when there is no burn). */
  zeroHours: number | null;
}

const NEXT_DOWN: Record<SurvivalTier, SurvivalTier | null> = {
  high: "normal", normal: "low_compute", low_compute: "critical", critical: "dead", dead: null,
};

function boundaryOf(tier: SurvivalTier, t: SurvivalThresholds): number {
  // The balance at or below which the agent drops out of `tier`.
  switch (tier) {
    case "high": return t.highCents;
    case "normal": return t.normalCents;
    case "low_compute": return t.lowComputeCents;
    default: return 0; // critical → dead below $0 (or after the grace at $0)
  }
}

export function computeRunway(
  db: Database,
  balanceCents: number,
  thresholds: SurvivalThresholds,
  now: Date = new Date(),
  windowHours: number = RUNWAY_WINDOW_HOURS,
): Runway {
  const first = db.prepare("SELECT MIN(occurred_at) AS t FROM ledger_entries").get() as { t: string | null };
  const firstMs = first.t ? Date.parse(first.t.includes("T") ? first.t : `${first.t.replace(" ", "T")}Z`) : NaN;
  const lived = Number.isFinite(firstMs) ? (now.getTime() - firstMs) / 3_600_000 : 0;
  const hours = Math.min(windowHours, Math.max(1, lived));
  const spentMc = getInferenceCostSinceMc(db, new Date(now.getTime() - hours * 3_600_000).toISOString());
  const burn = spentMc / MC_PER_CENT / hours;

  const tier = getSurvivalTier(balanceCents, thresholds);
  const next = NEXT_DOWN[tier];
  const boundary = boundaryOf(tier, thresholds);
  return {
    balanceCents,
    tier,
    windowHours: Math.round(hours * 10) / 10,
    burnCentsPerHour: burn,
    nextTier: next ? { tier: next, boundaryCents: boundary, hours: burn > 0 ? Math.max(0, (balanceCents - boundary) / burn) : null } : null,
    zeroHours: balanceCents <= 0 ? 0 : burn > 0 ? balanceCents / burn : null,
  };
}

/** "45 min", "18 h", "3 d 4 h". */
export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? `${d} d ${h} h` : `${d} d`;
}

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const rate = (c: number) => (c >= 1 ? `${c.toFixed(1)}¢/h` : `${c.toFixed(2)}¢/h`);

/** The runway line for a balance that may be unreadable (status "unavailable" → no estimate). */
export function runwayLine(
  db: Database,
  balance: { balanceCents?: number; creditsCents: number; balanceStatus?: string },
  thresholds: SurvivalThresholds,
  now: Date = new Date(),
): string {
  if (balance.balanceStatus === "unavailable") return "Runway: unknown (balance could not be read)";
  try {
    return formatRunway(computeRunway(db, balance.balanceCents ?? balance.creditsCents, thresholds, now));
  } catch {
    return "Runway: unknown";
  }
}

/** One line for the agent's status, agent:status and preflight. */
export function formatRunway(r: Runway): string {
  if (r.tier === "dead" || r.balanceCents <= 0) {
    return `Runway: none (balance ${usd(r.balanceCents)}; dead below $0 or after the grace at $0)`;
  }
  if (r.burnCentsPerHour <= 0) {
    return `Runway: no inference spend in the last ${r.windowHours} h, so no estimate (balance ${usd(r.balanceCents)})`;
  }
  const next = r.nextTier && r.nextTier.hours !== null
    ? `; ${r.nextTier.tier} at ${usd(r.nextTier.boundaryCents)} in ~${formatDuration(r.nextTier.hours)}`
    : "";
  return `Runway: ${usd(r.balanceCents)} lasts ~${formatDuration(r.zeroHours ?? 0)} at ${rate(r.burnCentsPerHour)} ` +
    `(inference, last ${r.windowHours} h)${next}`;
}
