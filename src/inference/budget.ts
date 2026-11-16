/**
 * Inference Budget Tracker
 *
 * Tracks inference costs and enforces budget limits per call,
 * per hour, per session, and per day.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { InferenceCostRow, ModelStrategyConfig, TreasuryPolicy } from "../types.js";
import {
  inferenceInsertCost,
  inferenceGetSessionCosts,
  inferenceGetDailyCost,
  inferenceGetDailyCostMc,
  inferenceGetHourlyCost,
  inferenceGetHourlyCostMc,
  inferenceGetModelCosts,
} from "../state/database.js";
import {
  MC_PER_CENT,
  insertLedgerEntry,
  getLifetimeInferenceCostCents,
  getLifetimeInferenceCostMc,
} from "../state/ledger.js";

type Database = BetterSqlite3.Database;

/**
 * Resolve the daily inference cap from both config sources.
 * Returns the strictest positive limit; 0 means neither source sets a limit.
 * Invalid values (negative, NaN, Infinity) are ignored.
 */
export function resolveDailyInferenceCap(
  strategy: Pick<ModelStrategyConfig, "dailyBudgetCents">,
  treasury: Pick<TreasuryPolicy, "maxInferenceDailyCents"> | undefined,
): number {
  const limits = [strategy.dailyBudgetCents, treasury?.maxInferenceDailyCents].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return limits.length > 0 ? Math.min(...limits) : 0;
}

export type BudgetReservation =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: string };

/** Millicents (1/1000 cent) for a cents amount, rounded UP (never undercounts). */
export function centsToMcCeil(cents: number): number {
  return Math.max(0, Math.ceil(cents * MC_PER_CENT));
}

/** "95c" for whole cents, "0.312c" for sub-cent amounts. */
function fmtC(mc: number): string {
  return `${Number((mc / MC_PER_CENT).toFixed(3))}c`;
}

export class InferenceBudgetTracker {
  private db: Database;
  readonly config: ModelStrategyConfig;
  /**
   * Estimated cost (millicents) of calls that passed the check but are not
   * recorded yet. Counted in every cap, so parallel calls can't all pass
   * before any of them is recorded. In-memory: one tracker instance must be shared.
   */
  private reservedMc = 0;

  constructor(db: Database, config: ModelStrategyConfig) {
    this.db = db;
    this.config = config;
  }

  /** Cents reserved by calls that are still running (may be fractional). */
  getReservedCents(): number {
    return this.reservedMc / MC_PER_CENT;
  }

  /**
   * Check every cap (including the session cap when sessionId is given) and,
   * if allowed, reserve the estimate until release() is called. Call
   * release() after recordCost(), or when the call fails. Check and reserve
   * are synchronous, so no other call can run in between.
   *
   * Fork fix 6: estimatedCostCents may be fractional; it is rounded up to
   * whole millicents and every cap is compared exactly in millicents.
   */
  tryReserve(
    estimatedCostCents: number,
    model: string,
    sessionId?: string,
  ): BudgetReservation {
    const check = this.checkBudget(estimatedCostCents, model);
    if (!check.allowed) {
      return { allowed: false, reason: check.reason ?? "budget cap reached" };
    }

    const estimateMc = centsToMcCeil(estimatedCostCents);
    const sessionLimitMc = centsToMcCeil(this.config.sessionBudgetCents);
    if (sessionId && sessionLimitMc > 0 && estimateMc > 0) {
      const spentMc = this.getSessionCostMc(sessionId);
      if (spentMc + this.reservedMc + estimateMc > sessionLimitMc) {
        return {
          allowed: false,
          reason: `Session budget exceeded: ${fmtC(spentMc)} spent${this.inFlightText()} + ${fmtC(estimateMc)} estimated > ${fmtC(sessionLimitMc)} limit`,
        };
      }
    }

    this.reservedMc += estimateMc;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.reservedMc = Math.max(0, this.reservedMc - estimateMc);
      },
    };
  }

  private inFlightText(): string {
    return this.reservedMc > 0 ? ` + ${fmtC(this.reservedMc)} in flight` : "";
  }

  /**
   * Check whether a call with estimated cost is within budget, counting
   * calls still in flight. Does not reserve; callers that go on to make the
   * call must use tryReserve().
   * Returns { allowed: true } or { allowed: false, reason: "..." }.
   */
  checkBudget(
    estimatedCostCents: number,
    model: string,
  ): { allowed: boolean; reason?: string } {
    const reserved = this.reservedMc;
    const estimateMc = centsToMcCeil(estimatedCostCents);
    // Per-call ceiling check
    if (this.config.perCallCeilingCents > 0 && estimateMc > centsToMcCeil(this.config.perCallCeilingCents)) {
      return {
        allowed: false,
        reason: `Per-call cost ${fmtC(estimateMc)} exceeds ceiling of ${this.config.perCallCeilingCents}c`,
      };
    }

    // Lifetime real-money cap (fork change 3). Reads the append-only ledger, so
    // pruning inference_costs can't reset it. Free/local calls (estimate 0) still run.
    if (this.config.lifetimeBudgetCents > 0 && estimateMc > 0) {
      const lifetimeMc = this.getLifetimeCostMc();
      if (lifetimeMc + reserved + estimateMc > centsToMcCeil(this.config.lifetimeBudgetCents)) {
        return {
          allowed: false,
          reason: `Lifetime inference budget exhausted: ${fmtC(lifetimeMc)} spent${this.inFlightText()} + ${fmtC(estimateMc)} estimated > ${this.config.lifetimeBudgetCents}c limit. Paid inference is blocked; the owner must raise modelStrategy.lifetimeBudgetCents.`,
        };
      }
    }

    // Hourly budget check
    if (this.config.hourlyBudgetCents > 0) {
      const hourlyMc = this.getHourlyCostMc();
      if (hourlyMc + reserved + estimateMc > centsToMcCeil(this.config.hourlyBudgetCents)) {
        return {
          allowed: false,
          reason: `Hourly budget exhausted: ${fmtC(hourlyMc)} spent${this.inFlightText()} + ${fmtC(estimateMc)} estimated > ${this.config.hourlyBudgetCents}c limit`,
        };
      }
    }

    // Daily budget check (UTC day)
    if (this.config.dailyBudgetCents > 0) {
      const dailyMc = this.getDailyCostMc();
      if (dailyMc + reserved + estimateMc > centsToMcCeil(this.config.dailyBudgetCents)) {
        return {
          allowed: false,
          reason: `Daily inference budget exhausted: ${fmtC(dailyMc)} spent${this.inFlightText()} + ${fmtC(estimateMc)} estimated > ${this.config.dailyBudgetCents}c limit`,
        };
      }
    }

    // The session cap needs a session id: see tryReserve().

    return { allowed: true };
  }

  /**
   * Record a completed inference cost. Fork fix 6: cost.costMc (exact, rounded
   * up per call) is what the caps and the ledger count; without it, costCents
   * × 1000. costCents is stored as costMc rounded up to whole cents.
   */
  recordCost(
    cost: Omit<InferenceCostRow, "id" | "createdAt">,
    source = "inference_router",
  ): void {
    const costMc = cost.costMc !== undefined ? Math.max(0, Math.ceil(cost.costMc)) : centsToMcCeil(cost.costCents);
    const costCents = Math.ceil(costMc / MC_PER_CENT);
    // Cost row + ledger debit in one transaction (fork change 3). Inference is
    // always paid with real money, so the debit is livemode = 1 on any network.
    this.db.transaction(() => {
      const id = inferenceInsertCost(this.db, { ...cost, costCents, costMc });
      if (costMc > 0) {
        insertLedgerEntry(this.db, {
          kind: "inference_cost",
          amountCents: -costCents,
          amountMc: -costMc,
          livemode: true,
          source,
          externalId: id,
          memo: `${cost.model} ${cost.taskType}`,
        });
      }
    })();
  }

  /** Total cost for the current hour, in millicents (exact). */
  getHourlyCostMc(): number {
    return inferenceGetHourlyCostMc(this.db);
  }

  /** Total cost for the current hour, in whole cents rounded up. */
  getHourlyCost(): number {
    return inferenceGetHourlyCost(this.db);
  }

  /** Total cost for today (or a specific date), in millicents (exact). */
  getDailyCostMc(date?: string): number {
    return inferenceGetDailyCostMc(this.db, date);
  }

  /** Total cost for today (or a specific date), in whole cents rounded up. */
  getDailyCost(date?: string): number {
    return inferenceGetDailyCost(this.db, date);
  }

  /** Total real-money inference spend, all time (from the ledger), in millicents. */
  getLifetimeCostMc(): number {
    return getLifetimeInferenceCostMc(this.db);
  }

  /** Total real-money inference spend, all time, in whole cents rounded up. */
  getLifetimeCost(): number {
    return getLifetimeInferenceCostCents(this.db);
  }

  /** Total cost for a session, in millicents (exact). */
  getSessionCostMc(sessionId: string): number {
    const costs = inferenceGetSessionCosts(this.db, sessionId);
    return costs.reduce((sum, c) => sum + (c.costMc ?? c.costCents * MC_PER_CENT), 0);
  }

  /** Total cost for a session, in whole cents rounded up. */
  getSessionCost(sessionId: string): number {
    return Math.ceil(this.getSessionCostMc(sessionId) / MC_PER_CENT);
  }

  /**
   * Get cost breakdown for a specific model.
   */
  getModelCosts(model: string, days?: number): { totalCents: number; totalMc: number; callCount: number } {
    return inferenceGetModelCosts(this.db, model, days);
  }
}
