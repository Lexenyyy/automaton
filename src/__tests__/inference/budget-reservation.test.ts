/**
 * Fork Phase 1, step 2: in-flight reservations stop parallel calls from
 * passing the budget check together before any of them is recorded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../inference/types.js";
import {
  MeteredInferenceClient,
  InferenceBudgetExceededError,
} from "../../inference/metered-client.js";
import { ProviderRegistry } from "../../inference/provider-registry.js";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceRouter } from "../../inference/router.js";
import type { UnifiedInferenceResult } from "../../inference/inference-client.js";
import type { ModelStrategyConfig } from "../../types.js";
import { createTestDb } from "../mocks.js";

type TestDb = ReturnType<typeof createTestDb>;
let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  delete process.env.AUTOMATON_CREDITS_BALANCE;
});
afterEach(() => db.close());

function tracker(over: Partial<ModelStrategyConfig> = {}) {
  return new InferenceBudgetTracker(db.raw, {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    perCallCeilingCents: 0,
    hourlyBudgetCents: 0,
    lifetimeBudgetCents: 0,
    ...over,
  } as ModelStrategyConfig);
}

describe("InferenceBudgetTracker.tryReserve", () => {
  it("counts reserved cents against the daily cap until released", () => {
    const t = tracker({ dailyBudgetCents: 10 });
    const first = t.tryReserve(6, "m");
    expect(first.allowed).toBe(true);
    expect(t.getReservedCents()).toBe(6);

    const second = t.tryReserve(6, "m");
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.reason).toContain("in flight");

    if (first.allowed) first.release();
    expect(t.getReservedCents()).toBe(0);
    expect(t.tryReserve(6, "m").allowed).toBe(true);
  });

  it("counts reserved cents against the lifetime and hourly caps", () => {
    const life = tracker({ lifetimeBudgetCents: 10 });
    expect(life.tryReserve(8, "m").allowed).toBe(true);
    expect(life.tryReserve(3, "m").allowed).toBe(false);

    const hourly = tracker({ hourlyBudgetCents: 10 });
    expect(hourly.tryReserve(8, "m").allowed).toBe(true);
    expect(hourly.tryReserve(3, "m").allowed).toBe(false);
  });

  it("checks the session cap when a session id is given", () => {
    const t = tracker({ sessionBudgetCents: 5 });
    expect(t.tryReserve(4, "m", "s1").allowed).toBe(true);
    const r = t.tryReserve(2, "m", "s1");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("Session budget exceeded");
  });

  it("release is idempotent", () => {
    const t = tracker({ dailyBudgetCents: 100 });
    const a = t.tryReserve(5, "m");
    const b = t.tryReserve(7, "m");
    if (a.allowed) {
      a.release();
      a.release();
    }
    expect(t.getReservedCents()).toBe(7);
    if (b.allowed) b.release();
    expect(t.getReservedCents()).toBe(0);
  });

  it("free calls (estimate 0) reserve nothing and still run", () => {
    const t = tracker({ dailyBudgetCents: 1, lifetimeBudgetCents: 1 });
    expect(t.tryReserve(1, "m").allowed).toBe(true);
    expect(t.tryReserve(0, "llama").allowed).toBe(true);
  });
});

describe("InferenceRouter reservations", () => {
  it("holds a reservation during the call and releases it after recording", async () => {
    const t = tracker({ dailyBudgetCents: 100 });
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    const router = new InferenceRouter(db.raw, reg, t);
    let reservedDuringCall = -1;
    const result = await router.route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      async () => {
        reservedDuringCall = t.getReservedCents();
        return { message: { content: "ok" }, usage: { promptTokens: 10, completionTokens: 10 } };
      },
    );
    expect(result.finishReason).toBe("stop");
    expect(reservedDuringCall).toBeGreaterThan(0);
    expect(t.getReservedCents()).toBe(0);
  });

  it("releases the reservation when the call throws", async () => {
    const t = tracker({ dailyBudgetCents: 100 });
    const reg = new ModelRegistry(db.raw);
    reg.initialize();
    const router = new InferenceRouter(db.raw, reg, t);
    await expect(
      router.route(
        { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
        async () => { throw new Error("down"); },
      ),
    ).rejects.toThrow("down");
    expect(t.getReservedCents()).toBe(0);
  });
});

describe("MeteredInferenceClient with parallel calls", () => {
  const registry = () =>
    new ProviderRegistry(
      [
        {
          id: "openai",
          name: "openai",
          baseUrl: "https://api.example.com/v1",
          apiKeyEnvVar: "TEST_KEY",
          models: [
            {
              id: "gpt-4.1-mini",
              tier: "fast",
              contextWindow: 128000,
              maxOutputTokens: 16384,
              costPerInputToken: 0.4,
              costPerOutputToken: 1.6,
              supportsTools: true,
              supportsVision: false,
              supportsStreaming: true,
            },
          ],
          maxRequestsPerMinute: 100,
          maxTokensPerMinute: 100_000,
          priority: 1,
          enabled: true,
        },
      ],
      {
        reasoning: { preferredProvider: "openai", fallbackOrder: [] },
        fast: { preferredProvider: "openai", fallbackOrder: [] },
        cheap: { preferredProvider: "openai", fallbackOrder: [] },
      },
    );

  const ok: UnifiedInferenceResult = {
    content: "ok",
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    cost: { inputCostCredits: 0, outputCostCredits: 0, totalCostCredits: 0 },
    metadata: { providerId: "openai", modelId: "gpt-4.1-mini", tier: "fast", latencyMs: 1, retries: 0, failedProviders: [] },
  };

  it("refuses a second call while the first is still running, then allows it", async () => {
    // Default output cap is clamped to the model's 16384 output tokens:
    // ceil(16384 * 1.6/1e4) = 3c per call. Daily cap 5c fits one call, not two.
    const t = tracker({ dailyBudgetCents: 5, perCallCeilingCents: 5 });
    let finishFirst: (() => void) | undefined;
    const inner = {
      chat: vi.fn(() =>
        finishFirst
          ? Promise.resolve(ok) // a wrongly admitted second call must not hang the test
          : new Promise<UnifiedInferenceResult>((resolve) => {
              finishFirst = () => resolve(ok);
            }),
      ),
      chatDirect: vi.fn(),
    };
    const client = new MeteredInferenceClient(inner as any, registry(), t, {
      source: "test",
      taskType: "planning",
    });
    const msgs = [{ role: "user" as const, content: "hi" }];

    const first = client.chat({ tier: "fast", messages: msgs });
    const second = await client.chat({ tier: "fast", messages: msgs }).then(
      () => "allowed",
      (e) => e,
    );
    expect(second).toBeInstanceOf(InferenceBudgetExceededError);
    expect(inner.chat).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await first;
    expect(t.getReservedCents()).toBe(0);
  });

  it("releases the reservation when the call fails", async () => {
    const t = tracker({ dailyBudgetCents: 100 });
    const inner = { chat: vi.fn(async () => { throw new Error("down"); }), chatDirect: vi.fn() };
    const client = new MeteredInferenceClient(inner as any, registry(), t, {
      source: "test",
      taskType: "planning",
    });
    await expect(client.chat({ tier: "fast", messages: [{ role: "user", content: "x" }] })).rejects.toThrow("down");
    expect(t.getReservedCents()).toBe(0);
  });
});
