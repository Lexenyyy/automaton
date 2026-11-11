/**
 * Resource Monitor
 *
 * Continuously monitors the automaton's resources and triggers
 * survival mode transitions when needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { ConwayBalanceSource, toFinancialState, formatBalance, type BalanceSource } from "./balance.js";

export interface ResourceStatus {
  financial: FinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
}

/**
 * Check all resources and return current status.
 */
export async function checkResources(
  identity: AutomatonIdentity,
  conway: ConwayClient,
  db: AutomatonDatabase,
  balanceSource?: BalanceSource,
): Promise<ResourceStatus> {
  // Survival balance (fork change 3). Callers pass the configured source;
  // without one, the upstream Conway-credits behavior is kept.
  const source = balanceSource ?? new ConwayBalanceSource(db.raw, conway, identity.address, identity.chainType);
  const financial = toFinancialState(await source.read());

  // Check sandbox health
  let sandboxHealthy = true;
  try {
    const result = await conway.exec("echo ok", 5000);
    sandboxHealthy = result.exitCode === 0;
  } catch {
    sandboxHealthy = false;
  }

  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  // An unavailable balance says nothing about funds: keep the previous tier.
  const tier = financial.balanceStatus === "unavailable" && previousTier
    ? previousTier
    : getSurvivalTier(financial.creditsCents);
  const tierChanged = previousTier !== null && previousTier !== tier;

  // Store current tier
  db.setKV("current_tier", tier);

  // Store financial state
  db.setKV("financial_state", JSON.stringify(financial));

  return {
    financial,
    tier,
    previousTier,
    tierChanged,
    sandboxHealthy,
  };
}

/**
 * Generate a human-readable resource report.
 */
export function formatResourceReport(status: ResourceStatus): string {
  const lines = [
    `=== RESOURCE STATUS ===`,
    `Balance: ${formatBalance(status.financial)}`,
    `USDC: ${status.financial.usdcBalance.toFixed(6)}`,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}
