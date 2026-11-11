/**
 * Fork change 3: lifetime real-money inference cap.
 * Testnet USDC can keep the agent alive while it spends real money on
 * inference, so paid inference stops once the all-time total reaches the cap.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6, MIGRATION_V12 } from "../state/schema.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG as SHARED_DEFAULTS } from "../types.js";
import { inferencePruneCosts, modelRegistryUpsert } from "../state/database.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  db.exec(MIGRATION_V12);
});

afterEach(() => db.close());

// Only the lifetime cap is active in these trackers.
const onlyLifetime = (cents: number) => ({
  ...DEFAULT_MODEL_STRATEGY_CONFIG,
  lifetimeBudgetCents: cents,
  dailyBudgetCents: 0,
  hourlyBudgetCents: 0,
  perCallCeilingCents: 0,
  sessionBudgetCents: 0,
});

function spend(tracker: InferenceBudgetTracker, cents: number) {
  tracker.recordCost({
    sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai",
    inputTokens: 1000, outputTokens: 500, costCents: cents, latencyMs: 1,
    tier: "normal", taskType: "agent_turn", cacheHit: false,
  });
}

describe("lifetime inference cap", () => {
  it("defaults to 500 cents ($5 testing budget) in both default copies", () => {
    expect(DEFAULT_MODEL_STRATEGY_CONFIG.lifetimeBudgetCents).toBe(500);
    expect(SHARED_DEFAULTS.lifetimeBudgetCents).toBe(500);
  });

  it("allows paid calls below the cap and blocks the one that would pass it", () => {
    const tracker = new InferenceBudgetTracker(db, onlyLifetime(500));
    spend(tracker, 495);
    expect(tracker.checkBudget(5, "gpt-4.1-mini").allowed).toBe(true);
    const result = tracker.checkBudget(6, "gpt-4.1-mini");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Lifetime inference budget exhausted");
  });

  it("blocks every paid call once the cap is reached", () => {
    const tracker = new InferenceBudgetTracker(db, onlyLifetime(500));
    spend(tracker, 500);
    expect(tracker.checkBudget(1, "gpt-4.1-nano").allowed).toBe(false);
  });

  it("still allows free/local inference at the cap", () => {
    const tracker = new InferenceBudgetTracker(db, onlyLifetime(500));
    spend(tracker, 600);
    expect(tracker.checkBudget(0, "llama3:8b").allowed).toBe(true);
  });

  it("is not reset by pruning inference_costs (reads the ledger)", () => {
    const tracker = new InferenceBudgetTracker(db, onlyLifetime(500));
    spend(tracker, 500);
    db.exec("UPDATE inference_costs SET created_at = '2000-01-01 00:00:00'");
    inferencePruneCosts(db, 1);
    expect(tracker.getLifetimeCost()).toBe(500);
    expect(tracker.checkBudget(1, "gpt-4.1-nano").allowed).toBe(false);
  });

  it("0 means no lifetime limit", () => {
    const tracker = new InferenceBudgetTracker(db, onlyLifetime(0));
    spend(tracker, 10_000);
    expect(tracker.checkBudget(5, "gpt-4.1-mini").allowed).toBe(true);
  });

  it("router refuses paid inference without calling the model, but runs a free model", async () => {
    const tracker = new InferenceBudgetTracker(db, { ...onlyLifetime(500), inferenceModel: "llama3:8b" });
    spend(tracker, 500);
    const registry = new ModelRegistry(db);
    registry.initialize();
    const router = new InferenceRouter(db, registry, tracker);
    let calls = 0;
    const chat = async () => {
      calls++;
      return { message: { content: "ok" }, usage: { promptTokens: 1, completionTokens: 1 }, finishReason: "stop" };
    };

    const paid = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      chat,
    );
    expect(paid.finishReason).toBe("budget_exceeded");
    expect(paid.content).toContain("Lifetime");
    expect(calls).toBe(0);

    // A free local model (cost 0) still runs at the cap.
    for (const id of ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-5-mini"]) registry.setEnabled(id, false);
    const now = new Date().toISOString();
    modelRegistryUpsert(db, {
      modelId: "llama3:8b", provider: "ollama", displayName: "Llama 3 8B", tierMinimum: "critical",
      costPer1kInput: 0, costPer1kOutput: 0, maxTokens: 4096, contextWindow: 8192,
      supportsTools: true, supportsVision: false, parameterStyle: "max_tokens", enabled: true,
      createdAt: now, updatedAt: now,
    });
    const free = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      chat,
    );
    expect(free.finishReason).toBe("stop");
    expect(free.model).toBe("llama3:8b");
    expect(calls).toBe(1);
  });
});
