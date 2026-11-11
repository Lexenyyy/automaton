/**
 * Fork Phase 1: every UnifiedInferenceClient call goes through the budget
 * tracker and the ledger via MeteredInferenceClient.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MeteredInferenceClient,
  InferenceBudgetExceededError,
  isInferenceBudgetExceededError,
} from "../../inference/metered-client.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../inference/types.js";
import { ProviderRegistry, type ProviderConfig } from "../../inference/provider-registry.js";
import type { UnifiedInferenceResult } from "../../inference/inference-client.js";
import { getLifetimeInferenceCostCents } from "../../state/ledger.js";
import type { ModelStrategyConfig } from "../../types.js";
import { createTestDb } from "../mocks.js";

type TestDb = ReturnType<typeof createTestDb>;

function provider(over: Partial<ProviderConfig> & Pick<ProviderConfig, "id" | "models">): ProviderConfig {
  return {
    name: over.id,
    baseUrl: "https://api.example.com/v1",
    apiKeyEnvVar: "TEST_KEY",
    maxRequestsPerMinute: 100,
    maxTokensPerMinute: 100_000,
    priority: 1,
    enabled: true,
    ...over,
  };
}

const model = (id: string, tier: "reasoning" | "fast" | "cheap", inPrice: number, outPrice: number, maxOut = 16384) => ({
  id,
  tier,
  contextWindow: 128000,
  maxOutputTokens: maxOut,
  costPerInputToken: inPrice,
  costPerOutputToken: outPrice,
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
});

const TIERS = {
  reasoning: { preferredProvider: "openai", fallbackOrder: [] },
  fast: { preferredProvider: "openai", fallbackOrder: [] },
  cheap: { preferredProvider: "openai", fallbackOrder: [] },
};

function result(providerId: string, modelId: string, inputTokens: number, outputTokens: number): UnifiedInferenceResult {
  return {
    content: "ok",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    cost: { inputCostCredits: 0, outputCostCredits: 0, totalCostCredits: 0 },
    metadata: { providerId, modelId, tier: "fast", latencyMs: 5, retries: 0, failedProviders: [] },
  };
}

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  delete process.env.AUTOMATON_CREDITS_BALANCE;
});

afterEach(() => db.close());

function setup(opts: {
  providers?: ProviderConfig[];
  config?: Partial<ModelStrategyConfig>;
  response?: UnifiedInferenceResult;
}) {
  const registry = new ProviderRegistry(
    opts.providers ?? [provider({ id: "openai", models: [model("gpt-4.1-mini", "fast", 0.4, 1.6)] })],
    TIERS,
  );
  const tracker = new InferenceBudgetTracker(db.raw, {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...opts.config,
  } as ModelStrategyConfig);
  const inner = {
    chat: vi.fn(async () => opts.response ?? result("openai", "gpt-4.1-mini", 1000, 500)),
    chatDirect: vi.fn(async () => opts.response ?? result("openai", "gpt-4.1-mini", 1000, 500)),
  };
  const client = new MeteredInferenceClient(inner, registry, tracker, {
    source: "test_source",
    taskType: "planning",
  });
  return { client, inner, tracker };
}

const MSG = [{ role: "user" as const, content: "hello" }];

describe("MeteredInferenceClient", () => {
  it("records cost in inference_costs and the ledger with its source", async () => {
    const { client } = setup({});
    await client.chat({ tier: "fast", messages: MSG });

    // 1000 * 0.4/1e4 + 500 * 1.6/1e4 = 0.04 + 0.08 = 0.12c → ceil 1c
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(1);
    const row = db.raw
      .prepare("SELECT source, amount_cents FROM ledger_entries WHERE kind = 'inference_cost'")
      .get() as { source: string; amount_cents: number };
    expect(row).toEqual({ source: "test_source", amount_cents: -1 });
    const cost = db.raw.prepare("SELECT model, task_type FROM inference_costs").get() as any;
    expect(cost).toEqual({ model: "gpt-4.1-mini", task_type: "planning" });
  });

  it("refuses over the lifetime cap without calling the model", async () => {
    const { client, inner } = setup({ config: { lifetimeBudgetCents: 0.5 as any } });
    // lifetime cap below any paid estimate (estimate >= 1c)
    await expect(client.chat({ tier: "fast", messages: MSG })).rejects.toBeInstanceOf(
      InferenceBudgetExceededError,
    );
    expect(inner.chat).not.toHaveBeenCalled();
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(0);
  });

  it("refuses over the daily cap without calling the model", async () => {
    const { client, inner, tracker } = setup({ config: { dailyBudgetCents: 3 } });
    tracker.recordCost({
      sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai",
      inputTokens: 0, outputTokens: 0, costCents: 3, latencyMs: 0,
      tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    const err = await client.chat({ tier: "fast", messages: MSG }).catch((e) => e);
    expect(isInferenceBudgetExceededError(err)).toBe(true);
    expect(inner.chat).not.toHaveBeenCalled();
  });

  it("refuses an explicit maxTokens above the per-call ceiling", async () => {
    const { client, inner } = setup({ config: { perCallCeilingCents: 5 } });
    // 100k output tokens * 1.6/1e4 = 16c > 5c
    await expect(
      client.chat({ tier: "fast", messages: MSG, maxTokens: 100_000 }),
    ).rejects.toBeInstanceOf(InferenceBudgetExceededError);
    expect(inner.chat).not.toHaveBeenCalled();
  });

  it("default output cap keeps the call within the per-call ceiling on the priciest tier model", async () => {
    const { client, inner } = setup({
      providers: [
        provider({ id: "openai", models: [model("gpt-4.1", "reasoning", 2.0, 8.0, 32768)] }),
        provider({ id: "groq", priority: 2, models: [model("llama-x", "reasoning", 0.2, 0.2)] }),
      ],
      config: { perCallCeilingCents: 5 },
      response: result("openai", "gpt-4.1", 10, 10),
    });
    await client.chat({ tier: "reasoning", messages: MSG });
    const sent = (inner.chat.mock.calls[0] as any[])[0];
    // 5c / (8/1e4 c per token) = 6250 tokens, minus the tiny input cost
    expect(sent.maxTokens).toBeGreaterThan(6000);
    expect(sent.maxTokens).toBeLessThan(6250);
    const inputTokens = Math.ceil("hello".length / 4);
    const worstCents = inputTokens * (2.0 / 1e4) + sent.maxTokens * (8.0 / 1e4);
    expect(Math.ceil(worstCents)).toBeLessThanOrEqual(5);
  });

  it("keeps a caller-provided maxTokens", async () => {
    const { client, inner } = setup({});
    await client.chat({ tier: "fast", messages: MSG, maxTokens: 300 });
    expect((inner.chat.mock.calls[0] as any[])[0].maxTokens).toBe(300);
  });

  it("charges an unknown remote model at the highest built-in price", async () => {
    const { client } = setup({
      providers: [provider({ id: "openai", models: [model("mystery", "fast", 0, 0)] })],
      response: result("openai", "mystery", 10_000, 10_000),
    });
    await client.chat({ tier: "fast", messages: MSG, maxTokens: 100 });
    // highest built-in is gpt-4.1: 10k * 2/1e4 + 10k * 8/1e4 = 2 + 8 = 10c
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(10);
  });

  it("never prices a known model below its built-in price", async () => {
    const { client } = setup({
      providers: [provider({ id: "openai", models: [model("gpt-4.1-mini", "fast", 0, 0)] })],
      response: result("openai", "gpt-4.1-mini", 10_000, 10_000),
    });
    await client.chat({ tier: "fast", messages: MSG, maxTokens: 100 });
    // built-in: 10k * 0.4/1e4 + 10k * 1.6/1e4 = 0.4 + 1.6 = 2c
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(2);
  });

  it("lets local loopback models run free, even past the lifetime cap", async () => {
    const { client, inner } = setup({
      providers: [
        provider({
          id: "local",
          baseUrl: "http://localhost:11434/v1",
          models: [model("llama3.1:8b", "fast", 0, 0)],
        }),
      ],
      config: { lifetimeBudgetCents: 1 },
      response: result("local", "llama3.1:8b", 5000, 5000),
    });
    await client.chat({ tier: "fast", messages: MSG });
    expect(inner.chat).toHaveBeenCalledTimes(1);
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(0);
  });

  it("does not treat a zero-priced remote 'local' provider as free", async () => {
    const { client } = setup({
      providers: [
        provider({
          id: "local",
          baseUrl: "https://remote.example.com/v1",
          models: [model("llama3.1:8b", "fast", 0, 0)],
        }),
      ],
      response: result("local", "llama3.1:8b", 10_000, 10_000),
    });
    await client.chat({ tier: "fast", messages: MSG, maxTokens: 100 });
    expect(getLifetimeInferenceCostCents(db.raw)).toBeGreaterThan(0);
  });

  it("charges the estimate when a paid call reports no usage", async () => {
    const { client } = setup({ response: result("openai", "gpt-4.1-mini", 0, 0) });
    await client.chat({ tier: "fast", messages: MSG, maxTokens: 2000 });
    // estimate: ceil(2 * 0.4/1e4 + 2000 * 1.6/1e4) = ceil(0.32) = 1c
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(1);
  });

  it("meters chatDirect too", async () => {
    const { client, inner } = setup({ config: { lifetimeBudgetCents: 0.5 as any } });
    await expect(
      client.chatDirect({ providerId: "openai", modelId: "gpt-4.1-mini", messages: MSG }),
    ).rejects.toBeInstanceOf(InferenceBudgetExceededError);
    expect(inner.chatDirect).not.toHaveBeenCalled();
  });

  it("records nothing when the provider call fails", async () => {
    const { client, inner } = setup({});
    inner.chat.mockRejectedValueOnce(new Error("boom"));
    await expect(client.chat({ tier: "fast", messages: MSG })).rejects.toThrow("boom");
    expect(getLifetimeInferenceCostCents(db.raw)).toBe(0);
  });
});
