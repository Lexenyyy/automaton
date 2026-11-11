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
  inferenceGetHourlyCost,
  inferenceGetModelCosts,
} from "../state/database.js";
import { insertLedgerEntry, getLifetimeInferenceCostCents } from "../state/ledger.js";

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

export class InferenceBudgetTracker {
  private db: Database;
  readonly config: ModelStrategyConfig;
  /**
   * Estimated cost of calls that passed the check but are not recorded yet.
   * Counted in every cap, so parallel calls can't all pass before any of
   * them is recorded. In-memory: one tracker instance must be shared.
   */
  private reservedCents = 0;

  constructor(db: Database, config: ModelStrategyConfig) {
    this.db = db;
    this.config = config;
  }

  /** Cents reserved by calls that are still running. */
  getReservedCents(): number {
    return this.reservedCents;
  }

  /**
   * Check every cap (including the session cap when sessionId is given) and,
   * if allowed, reserve the estimate until release() is called. Call
   * release() after recordCost(), or when the call fails. Check and reserve
   * are synchronous, so no other call can run in between.
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

    const sessionLimit = this.config.sessionBudgetCents;
    if (sessionId && sessionLimit > 0 && estimatedCostCents > 0) {
      const spent = this.getSessionCost(sessionId);
      if (spent + this.reservedCents + estimatedCostCents > sessionLimit) {
        return {
          allowed: false,
          reason: `Session budget exceeded: ${spent}c spent${this.inFlightText()} + ${estimatedCostCents}c estimated > ${sessionLimit}c limit`,
        };
      }
    }

    const amount = Math.max(0, estimatedCostCents);
    this.reservedCents += amount;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.reservedCents = Math.max(0, this.reservedCents - amount);
      },
    };
  }

  private inFlightText(): string {
    return this.reservedCents > 0 ? ` + ${this.reservedCents}c in flight` : "";
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
    const reserved = this.reservedCents;
    // Per-call ceiling check
    if (this.config.perCallCeilingCents > 0 && estimatedCostCents > this.config.perCallCeilingCents) {
      return {
        allowed: false,
        reason: `Per-call cost ${estimatedCostCents}c exceeds ceiling of ${this.config.perCallCeilingCents}c`,
      };
    }

    // Lifetime real-money cap (fork change 3). Reads the append-only ledger, so
    // pruning inference_costs can't reset it. Free/local calls (estimate 0) still run.
    if (this.config.lifetimeBudgetCents > 0 && estimatedCostCents > 0) {
      const lifetime = this.getLifetimeCost();
      if (lifetime + reserved + estimatedCostCents > this.config.lifetimeBudgetCents) {
        return {
          allowed: false,
          reason: `Lifetime inference budget exhausted: ${lifetime}c spent${this.inFlightText()} + ${estimatedCostCents}c estimated > ${this.config.lifetimeBudgetCents}c limit. Paid inference is blocked; the owner must raise modelStrategy.lifetimeBudgetCents.`,
        };
      }
    }

    // Hourly budget check
    if (this.config.hourlyBudgetCents > 0) {
      const hourlyCost = this.getHourlyCost();
      if (hourlyCost + reserved + estimatedCostCents > this.config.hourlyBudgetCents) {
        return {
          allowed: false,
          reason: `Hourly budget exhausted: ${hourlyCost}c spent${this.inFlightText()} + ${estimatedCostCents}c estimated > ${this.config.hourlyBudgetCents}c limit`,
        };
      }
    }

    // Daily budget check (UTC day)
    if (this.config.dailyBudgetCents > 0) {
      const dailyCost = this.getDailyCost();
      if (dailyCost + reserved + estimatedCostCents > this.config.dailyBudgetCents) {
        return {
          allowed: false,
          reason: `Daily inference budget exhausted: ${dailyCost}c spent${this.inFlightText()} + ${estimatedCostCents}c estimated > ${this.config.dailyBudgetCents}c limit`,
        };
      }
    }

    // The session cap needs a session id: see tryReserve().

    return { allowed: true };
  }

  /**
   * Record a completed inference cost.
   */
  recordCost(
    cost: Omit<InferenceCostRow, "id" | "createdAt">,
    source = "inference_router",
  ): void {
    // Cost row + ledger debit in one transaction (fork change 3). Inference is
    // always paid with real money, so the debit is livemode = 1 on any network.
    this.db.transaction(() => {
      const id = inferenceInsertCost(this.db, cost);
      if (cost.costCents > 0) {
        insertLedgerEntry(this.db, {
          kind: "inference_cost",
          amountCents: -cost.costCents,
          livemode: true,
          source,
          externalId: id,
          memo: `${cost.model} ${cost.taskType}`,
        });
      }
    })();
  }

  /**
   * Get total cost for the current hour.
   */
  getHourlyCost(): number {
    return inferenceGetHourlyCost(this.db);
  }

  /**
   * Get total cost for today (or a specific date).
   */
  getDailyCost(date?: string): number {
    return inferenceGetDailyCost(this.db, date);
  }

  /**
   * Total real-money inference spend, all time (from the ledger).
   */
  getLifetimeCost(): number {
    return getLifetimeInferenceCostCents(this.db);
  }

  /**
   * Get total cost for a specific session.
   */
  getSessionCost(sessionId: string): number {
    const costs = inferenceGetSessionCosts(this.db, sessionId);
    return costs.reduce((sum, c) => sum + c.costCents, 0);
  }

  /**
   * Get cost breakdown for a specific model.
   */
  getModelCosts(model: string, days?: number): { totalCents: number; callCount: number } {
    return inferenceGetModelCosts(this.db, model, days);
  }
}
