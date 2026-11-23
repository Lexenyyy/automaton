/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { DEFAULT_SURVIVAL_SETTINGS, type SurvivalThresholds } from "../survival/settings.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current credits.
 * Thresholds are checked in descending order: high > normal > low_compute > critical > dead.
 *
 * Zero credits = "critical" (broke but alive — can still accept funding, send distress).
 * Only negative balance (API-confirmed debt) = "dead".
 *
 * Fork (Phase 4 step 2): thresholds are owner settings (config.survival,
 * src/survival/settings.ts). Production callers pass resolveSurvivalSettings(config)
 * (a test enforces it); the default equals the old hardcoded values.
 */
export function getSurvivalTier(
  creditsCents: number,
  thresholds: SurvivalThresholds = DEFAULT_SURVIVAL_SETTINGS,
): SurvivalTier {
  if (creditsCents > thresholds.highCents) return "high";
  if (creditsCents > thresholds.normalCents) return "normal";
  if (creditsCents > thresholds.lowComputeCents) return "low_compute";
  if (creditsCents >= 0) return "critical";
  return "dead";
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
