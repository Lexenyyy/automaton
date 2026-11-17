/**
 * Status snapshot and status-tool cache (fork, Phase 1).
 *
 * The first testnet run called system_synopsis and check_balance three times
 * before doing anything. The wake-up message now carries the status, and a
 * repeated status-tool call within one wake cycle returns the earlier result
 * (no new RPC read) while nothing else has happened.
 */

import type { AutomatonConfig, AutomatonDatabase, FinancialState, ToolCallResult } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { formatBalance } from "../survival/balance.js";
import { getActiveNetwork } from "../identity/network.js";
import { MC_PER_CENT, formatUsdMc } from "../state/ledger.js";
import { getLastWakeEnd, getSoulState } from "./wake-state.js";
import { resolveMaxTurnsPerWake } from "./turn-limits.js";

export interface BudgetSnapshot {
  /** Exact spend in millicents (1/1000 cent). */
  dailySpentMc: number;
  dailyCapCents: number;
  lifetimeSpentMc: number;
  lifetimeCapCents: number;
}

const ofCap = (spentMc: number, capCents: number) =>
  capCents > 0
    ? `${formatUsdMc(spentMc)} of ${formatUsdMc(capCents * MC_PER_CENT)} cap`
    : `${formatUsdMc(spentMc)} (no cap)`;

/** Status block for the wake-up message. Never includes keys or the sandbox ID. */
export function buildStatusSnapshot(params: {
  config: AutomatonConfig;
  financial: FinancialState;
  db: AutomatonDatabase;
  budget?: BudgetSnapshot;
}): string {
  const { config, financial, db, budget } = params;
  const tier = financial.balanceStatus === "unavailable"
    ? "unknown (balance could not be read)"
    : getSurvivalTier(financial.creditsCents);
  let network = "unknown";
  try {
    network = getActiveNetwork().label;
  } catch {
    // network not activated (tests)
  }
  const lines = [
    `Balance: ${formatBalance(financial)}`,
    `Survival tier: ${tier}`,
    `Network: ${network}`,
  ];
  if (budget) {
    lines.push(`Inference today: ${ofCap(budget.dailySpentMc, budget.dailyCapCents)}`);
    lines.push(`Inference lifetime: ${ofCap(budget.lifetimeSpentMc, budget.lifetimeCapCents)}`);
  }
  let heartbeats = 0;
  try {
    heartbeats = db.getHeartbeatEntries().filter((h) => h.enabled).length;
  } catch {
    // heartbeat table not available
  }
  lines.push(`Active heartbeats: ${heartbeats}`);
  lines.push(`Model: ${config.inferenceModel}`);
  lines.push(`Turns this wake: at most ${resolveMaxTurnsPerWake(config)} (the wake is ended after that; sleep before it)`);
  // Fork: what is already done, so one-time setup is not repeated every wake.
  const soul = getSoulState(db.raw);
  lines.push(
    soul
      ? `SOUL.md: exists, version ${soul.version}, last updated ${soul.updatedAt.slice(0, 10)} (view_soul / update_soul; don't rewrite it without a real change)`
      : "SOUL.md: not written yet (write it with update_soul)",
  );
  const lastEnd = getLastWakeEnd(db.raw);
  if (lastEnd) lines.push(`Last wake ended: ${lastEnd.reason} (${lastEnd.at.slice(0, 16).replace("T", " ")} UTC)`);
  return `--- STATUS (current, ${new Date().toISOString()}) ---
${lines.join("\n")}
--- END STATUS ---
This status is current. You do not need check_balance, system_synopsis or other status tools to see it.
Your tools are in your tool definitions; you do not need to list them.`;
}

/** Read-only status tools whose results are cached within one wake cycle. */
export const CACHEABLE_STATUS_TOOLS = new Set([
  "check_balance",
  "system_synopsis",
  "check_credits",
  "check_usdc_balance",
  "check_inference_spending",
]);

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Per-wake-cycle cache of status-tool results. Any other tool call clears it
 * (it may have changed something), and entries expire after a few minutes.
 */
export class StatusToolCache {
  private entries = new Map<string, { result: string; at: number }>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly now: () => number = Date.now) {}

  private key(name: string, args: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(args ?? {})}`;
  }

  /** A cached answer for a repeated status call, or undefined (then run the tool). */
  lookup(id: string, name: string, args: Record<string, unknown>): ToolCallResult | undefined {
    if (!CACHEABLE_STATUS_TOOLS.has(name)) return undefined;
    const hit = this.entries.get(this.key(name, args));
    if (!hit || this.now() - hit.at > this.ttlMs) return undefined;
    return {
      id,
      name,
      arguments: args,
      result: `${hit.result}\n(Unchanged: you already checked this since waking up and nothing has happened since. Do not check again; act on it.)`,
      durationMs: 0,
    };
  }

  /** Record an executed tool result (not a cached one): caches status tools, clears the cache after any other tool. */
  record(result: ToolCallResult): void {
    if (!CACHEABLE_STATUS_TOOLS.has(result.name)) {
      this.entries.clear();
      return;
    }
    if (result.error) return;
    this.entries.set(this.key(result.name, result.arguments), { result: result.result, at: this.now() });
  }
}
