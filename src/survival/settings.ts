/**
 * Survival tier settings (fork, Phase 4 step 2).
 *
 * The tier thresholds and the grace before "dead" were hardcoded
 * (SURVIVAL_THRESHOLDS in types.ts, 1 hour in heartbeat check_credits). They
 * are now owner settings in config.survival:
 *   highCents        balance >  this → high        (default 500  = $5.00)
 *   normalCents      balance >  this → normal      (default 50   = $0.50)
 *   lowComputeCents  balance >  this → low_compute (default 10   = $0.10)
 *                    balance >= 0    → critical; below 0 → dead
 *   deadGraceMinutes minutes at <= $0 before the heartbeat sets "dead"
 *                    (default 60; minimum 1, so 0 cannot be set by accident)
 *   tierWakeMinGapMinutes  minimum gap between two tier-change wakes (Phase 4
 *                    step 3; default 60, 1..1440): a balance bouncing across a
 *                    boundary is recorded each time but wakes the agent at most
 *                    once per gap
 * The defaults equal the old hardcoded values exactly. Startup refuses values
 * that are not whole numbers, thresholds not strictly in order
 * (high > normal > lowCompute >= 0), and a grace outside 1..10080 minutes.
 */

import type { AutomatonConfig } from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

export interface SurvivalThresholds {
  highCents: number;
  normalCents: number;
  lowComputeCents: number;
}

export interface SurvivalSettings extends SurvivalThresholds {
  deadGraceMinutes: number;
  tierWakeMinGapMinutes: number;
}

export const DEFAULT_SURVIVAL_SETTINGS: Readonly<SurvivalSettings> = Object.freeze({
  highCents: SURVIVAL_THRESHOLDS.high,
  normalCents: SURVIVAL_THRESHOLDS.normal,
  lowComputeCents: SURVIVAL_THRESHOLDS.low_compute,
  deadGraceMinutes: 60,
  tierWakeMinGapMinutes: 60,
});

export const MIN_DEAD_GRACE_MINUTES = 1;
export const MAX_DEAD_GRACE_MINUTES = 10_080; // 7 days
export const MIN_TIER_WAKE_GAP_MINUTES = 1;
export const MAX_TIER_WAKE_GAP_MINUTES = 1_440; // 1 day
const KEYS = ["highCents", "normalCents", "lowComputeCents", "deadGraceMinutes", "tierWakeMinGapMinutes"] as const;

function merged(config: Pick<AutomatonConfig, "survival">): Record<(typeof KEYS)[number], unknown> {
  return { ...DEFAULT_SURVIVAL_SETTINGS, ...(config.survival ?? {}) };
}

/** Problems with config.survival (empty = valid). Partial settings are checked together with the defaults. */
export function checkSurvivalSettings(config: Pick<AutomatonConfig, "survival">): string[] {
  const raw = config.survival;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    return ["survival must be an object"];
  }
  const unknown = Object.keys(raw ?? {}).filter((k) => !(KEYS as readonly string[]).includes(k));
  const problems = unknown.map((k) => `survival.${k} is not a known setting (${KEYS.join(", ")})`);
  const s = merged(config);
  for (const key of KEYS) {
    if (!Number.isInteger(s[key]) || (s[key] as number) < 0) {
      problems.push(`survival.${key} must be a whole number >= 0 (got ${JSON.stringify(s[key])})`);
    }
  }
  if (problems.length) return problems;
  const { highCents, normalCents, lowComputeCents, deadGraceMinutes, tierWakeMinGapMinutes } = s as unknown as SurvivalSettings;
  if (!(highCents > normalCents && normalCents > lowComputeCents)) {
    problems.push(
      `survival thresholds must be in order highCents > normalCents > lowComputeCents >= 0 ` +
        `(got ${highCents} / ${normalCents} / ${lowComputeCents})`,
    );
  }
  if (deadGraceMinutes < MIN_DEAD_GRACE_MINUTES || deadGraceMinutes > MAX_DEAD_GRACE_MINUTES) {
    problems.push(
      `survival.deadGraceMinutes must be ${MIN_DEAD_GRACE_MINUTES}..${MAX_DEAD_GRACE_MINUTES} minutes (got ${deadGraceMinutes})`,
    );
  }
  if (tierWakeMinGapMinutes < MIN_TIER_WAKE_GAP_MINUTES || tierWakeMinGapMinutes > MAX_TIER_WAKE_GAP_MINUTES) {
    problems.push(
      `survival.tierWakeMinGapMinutes must be ${MIN_TIER_WAKE_GAP_MINUTES}..${MAX_TIER_WAKE_GAP_MINUTES} minutes (got ${tierWakeMinGapMinutes})`,
    );
  }
  return problems;
}

/** The settings in effect: the configured ones when valid, otherwise the defaults (startup refuses invalid ones). */
export function resolveSurvivalSettings(config: Pick<AutomatonConfig, "survival"> | null | undefined): SurvivalSettings {
  if (!config || checkSurvivalSettings(config).length > 0) return { ...DEFAULT_SURVIVAL_SETTINGS };
  return merged(config) as unknown as SurvivalSettings;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** One line for preflight. */
export function describeSurvivalSettings(s: SurvivalSettings): string {
  return `high > ${usd(s.highCents)}, normal > ${usd(s.normalCents)}, low_compute > ${usd(s.lowComputeCents)}, ` +
    `critical >= $0.00, dead below $0 or after ${s.deadGraceMinutes} min at <= $0; ` +
    `tier-change wakes at least ${s.tierWakeMinGapMinutes} min apart`;
}
