/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Reads the survival balance ONCE per tick, derives the survival tier,
 * and shares it across all tasks to avoid redundant calls.
 */

import type BetterSqlite3 from "better-sqlite3";

import type {
  ConwayClient,
  HeartbeatConfig,
  SurvivalTier,
  TickContext,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { ConwayBalanceSource, type BalanceSource } from "../survival/balance.js";

type DatabaseType = BetterSqlite3.Database;

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - Reads the balance ONCE from the balance source (fork change 3: wallet USDC
 *   + ledger by default; callers without one get the Conway source)
 * - Derives survivalTier from the balance. If the balance is unavailable, the
 *   last known tier is kept (a failed read must not push the agent toward dead)
 * - Reads lowComputeMultiplier from config
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  walletAddress?: string,
  chainType?: string,
  balanceSource?: BalanceSource,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  const source = balanceSource ?? new ConwayBalanceSource(db, conway, walletAddress ?? "", chainType);
  const snapshot = await source.read();

  const lastTierRow = db.prepare("SELECT value FROM kv WHERE key = 'last_tick_tier'").get() as { value: string } | undefined;
  let survivalTier: SurvivalTier;
  if (snapshot.status === "unavailable") {
    survivalTier = (lastTierRow?.value as SurvivalTier | undefined) ?? getSurvivalTier(snapshot.balanceCents);
  } else {
    survivalTier = getSurvivalTier(snapshot.balanceCents);
    db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('last_tick_tier', ?, datetime('now'))").run(survivalTier);
  }

  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance: snapshot.balanceCents,
    balanceStatus: snapshot.status,
    usdcBalance: snapshot.usdcBalance,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
  };
}
