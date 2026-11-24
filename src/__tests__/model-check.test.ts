/**
 * Fork (after the tier walk's gpt-4.1-nano 404): preflight confirms every
 * configured model with the provider's free model list; reasoning effort is a
 * checked setting, sent only to OpenAI reasoning models.
 */

import { describe, it, expect, vi } from "vitest";
import {
  checkReasoningEffort,
  collectConfiguredModels,
  fetchModelList,
  modelCheckLines,
  parseShutdownDate,
} from "../inference/model-check.js";
import { isOpenAiReasoningModel } from "../inference/types.js";
import { createInferenceClient } from "../conway/inference.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { createTestConfig } from "./mocks.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const list = (...models: [string, string?][]) => ({
  ok: true as const,
  models: new Map(models.map(([id, shutdownDate]) => [id, { id, shutdownDate }])),
});
const jsonResponse = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe("which models are checked", () => {
  it("main, cheap and critical models plus the models the agent may switch to, once each", () => {
    const config = createTestConfig({
      inferenceModel: "gpt-4.1-mini",
      modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, criticalModel: "gpt-4.1" },
      agentSettings: { model: { allowedModels: ["gpt-4.1-mini", "gpt-6-luna", "gpt-5.4-mini"] } },
    } as any);
    expect(collectConfiguredModels(config)).toEqual(["gpt-4.1-mini", "gpt-6-luna", "gpt-4.1", "gpt-5.4-mini"]);
  });
});

describe("model list call (free GET /v1/models)", () => {
  it("parses ids and shutdown dates (date string or Unix seconds)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      data: [
        { id: "gpt-4.1-mini", shutdown_date: "2027-01-14" },
        { id: "gpt-5-nano", shutdown_date: Date.parse("2026-12-11T00:00:00Z") / 1000 },
        { id: "gpt-6-luna", shutdown_date: null },
      ],
    }));
    const r = await fetchModelList("openai", "sk-test", fetchImpl as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models.get("gpt-4.1-mini")?.shutdownDate).toBe("2027-01-14");
    expect(r.models.get("gpt-5-nano")?.shutdownDate).toBe("2026-12-11");
    expect(r.models.get("gpt-6-luna")?.shutdownDate).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer sk-test" },
    }));
  });

  it("a rejected key gives status and error code only, never the body (OpenAI quotes part of the key)", async () => {
    const secret = "sk-proj-SECRETSECRET1234";
    const fetchImpl = vi.fn(async () => jsonResponse(401, {
      error: { message: `Incorrect API key provided: ${secret.slice(0, 8)}****1234.`, code: "invalid_api_key" },
    }));
    const r = await fetchModelList("openai", secret, fetchImpl as any);
    expect(r).toEqual({ ok: false, reason: "HTTP 401, invalid_api_key, key rejected" });
    expect(JSON.stringify(r)).not.toContain("1234");
  });

  it("unreachable or slow: not ok, with a short reason", async () => {
    const down = await fetchModelList("openai", "k", (async () => { throw new Error("ECONNREFUSED"); }) as any);
    expect(down).toEqual({ ok: false, reason: "unreachable" });
    const slow = await fetchModelList("openai", "k", ((_u: string, init: any) => new Promise((_r, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as any, 10);
    expect(slow).toEqual({ ok: false, reason: "no answer within 0 s" });
  });

  it("Anthropic uses its own headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [{ id: "claude-x" }] }));
    await fetchModelList("anthropic", "ak", fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.anthropic.com/v1/models?limit=1000", expect.objectContaining({
      headers: { "x-api-key": "ak", "anthropic-version": "2023-06-01" },
    }));
  });

  it("parseShutdownDate ignores junk", () => {
    expect(parseShutdownDate(null)).toBeUndefined();
    expect(parseShutdownDate("soon")).toBeUndefined();
    expect(parseShutdownDate(0)).toBeUndefined();
  });
});

describe("report lines", () => {
  it("a retired model FAILs (the tier walk's gpt-4.1-nano case)", () => {
    const lines = modelCheckLines("openai", ["gpt-4.1-mini", "gpt-4.1-nano"], list(["gpt-4.1-mini"]), NOW);
    expect(lines).toContainEqual({
      level: "FAIL", text: "model gpt-4.1-nano: not offered by openai (retired or unknown); the agent cannot use it",
    });
    expect(lines).toContainEqual({ level: "PASS", text: "model gpt-4.1-mini: listed by openai, no shutdown date" });
  });

  it("a shutdown date is a WARN with the days left; SOON within 30 days; passed date says replace now", () => {
    const lines = modelCheckLines(
      "openai",
      ["gpt-4.1-mini", "gpt-5-mini", "old"],
      list(["gpt-4.1-mini", "2027-01-14"], ["gpt-5-mini", "2026-12-11"], ["old", "2026-11-01"]),
      NOW,
    );
    expect(lines).toContainEqual({ level: "PASS", text: "model gpt-4.1-mini: listed by openai" });
    expect(lines).toContainEqual({ level: "WARN", text: "model gpt-4.1-mini: openai shuts it down on 2027-01-14 (51 days)" });
    expect(lines).toContainEqual({ level: "WARN", text: "model gpt-5-mini: openai shuts it down on 2026-12-11 (17 days), SOON: replace it" });
    expect(lines).toContainEqual({ level: "WARN", text: "model old: openai shutdown date 2026-11-01 has passed; replace it now" });
    expect(lines.some((l) => l.level === "FAIL")).toBe(false);
  });

  it("an unreadable list is one FAIL; its models are 'not checked', not FAILed again", () => {
    const lines = modelCheckLines("openai", ["a", "b"], { ok: false, reason: "HTTP 401, key rejected" }, NOW);
    expect(lines.filter((l) => l.level === "FAIL")).toEqual([
      { level: "FAIL", text: "model list (openai): could not read (HTTP 401, key rejected); models not confirmed" },
    ]);
    expect(lines.filter((l) => l.level === "INFO")).toHaveLength(2);
  });
});

describe("reasoning effort", () => {
  it("startup accepts the known values or none set, refuses anything else", () => {
    for (const v of ["none", "minimal", "low", "medium", "high", undefined]) {
      expect(checkReasoningEffort(createTestConfig({ modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, reasoningEffort: v as any } }))).toBeNull();
    }
    expect(checkReasoningEffort(createTestConfig({ modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, reasoningEffort: "max" as any } })))
      .toMatch(/modelStrategy\.reasoningEffort must be one of none, minimal, low, medium, high \(got "max"\)/);
  });

  it("only OpenAI reasoning models count as reasoning models", () => {
    for (const m of ["gpt-6-luna", "gpt-5.4-mini", "gpt-5-nano", "o3", "o4-mini", "gpt-10-x"]) expect(isOpenAiReasoningModel(m), m).toBe(true);
    for (const m of ["gpt-4.1-mini", "gpt-4o", "gpt-5-chat-latest", "claude-sonnet", "llama3"]) expect(isOpenAiReasoningModel(m), m).toBe(false);
  });

  async function sentBody(model: string, reasoningEffort?: string) {
    const fetchMock = vi.fn(async (_url: any, _init?: any) => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createInferenceClient({
        apiUrl: "https://unused.example", apiKey: "", defaultModel: model, maxTokens: 300,
        openaiApiKey: "sk-test", conwayEnabled: false, reasoningEffort,
      });
      await client.chat([{ role: "user", content: "hi" }], { tools: [{ type: "function", function: { name: "sleep", parameters: {} } }] as any });
      return JSON.parse(String(fetchMock.mock.calls[0][1]!.body));
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("gpt-6-luna: reasoning_effort none and max_completion_tokens, tools included (as in the owner's test call A)", async () => {
    const body = await sentBody("gpt-6-luna", "none");
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none", max_completion_tokens: 300, tool_choice: "auto" });
    expect(body.max_tokens).toBeUndefined();
  });

  it("gpt-4.1-mini: no reasoning_effort (the API would refuse it), max_completion_tokens as before", async () => {
    const body = await sentBody("gpt-4.1-mini", "none");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(300);
  });

  it("no setting: nothing sent", async () => {
    expect((await sentBody("gpt-6-luna")).reasoning_effort).toBeUndefined();
  });
});
