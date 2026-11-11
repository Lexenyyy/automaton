/**
 * Fork Phase 1, step 4: summarizeTurns goes through the InferenceRouter,
 * so its model call is capped and recorded like any other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeTurns } from "../agent/context.js";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { getLifetimeInferenceCostCents } from "../state/ledger.js";
import type { AgentTurn, ModelStrategyConfig } from "../types.js";
import { createTestDb } from "./mocks.js";

type TestDb = ReturnType<typeof createTestDb>;
let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());

function turns(n: number): AgentTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    timestamp: new Date().toISOString(),
    state: "running",
    input: "in",
    inputSource: "system",
    thinking: `thought ${i}`,
    toolCalls: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costCents: 0,
    durationMs: 0,
  })) as AgentTurn[];
}

function setup(over: Partial<ModelStrategyConfig> = {}) {
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const tracker = new InferenceBudgetTracker(db.raw, {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...over,
  } as ModelStrategyConfig);
  const router = new InferenceRouter(db.raw, registry, tracker);
  const chat = vi.fn(async () => ({
    id: "r",
    model: "gpt-4.1-mini",
    message: { role: "assistant" as const, content: "Model summary." },
    usage: { promptTokens: 2000, completionTokens: 300, totalTokens: 2300 },
    finishReason: "stop",
  }));
  return { router, chat };
}

describe("summarizeTurns via the router", () => {
  it("routes the call and records its cost as summarization", async () => {
    const { router, chat } = setup();
    const out = await summarizeTurns(turns(8), { router, chat, tier: "normal", sessionId: "s1" });
    expect(out).toBe("Previous activity summary:\nModel summary.");
    expect(chat).toHaveBeenCalledTimes(1);
    expect((chat.mock.calls[0] as any[])[1]).toMatchObject({ maxTokens: 500, temperature: 0 });
    const row = db.raw.prepare("SELECT task_type, cost_cents FROM inference_costs").get() as any;
    expect(row.task_type).toBe("summarization");
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(row.cost_cents);
  });

  it("uses the local summary without calling the model when the budget refuses", async () => {
    const { router, chat } = setup({ lifetimeBudgetCents: 1 });
    db.raw.prepare(
      `INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, currency, livemode, source, external_id)
       VALUES ('x', datetime('now'), 'inference_cost', -1, 'USD', 1, 'test', 'x')`,
    ).run();
    const out = await summarizeTurns(turns(8), { router, chat, tier: "normal" });
    expect(chat).not.toHaveBeenCalled();
    expect(out).toContain("thought 7");
  });

  it("uses no paid model at the critical tier", async () => {
    const { router, chat } = setup();
    const out = await summarizeTurns(turns(8), { router, chat, tier: "critical" });
    expect(chat).not.toHaveBeenCalled();
    expect(out).toContain("thought 7");
  });

  it("does not call the model for 5 turns or fewer", async () => {
    const { router, chat } = setup();
    await summarizeTurns(turns(5), { router, chat, tier: "normal" });
    expect(chat).not.toHaveBeenCalled();
  });
});
