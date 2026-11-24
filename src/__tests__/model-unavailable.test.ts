/**
 * Fork (after the tier walk's gpt-4.1-nano 404): a model the provider does not
 * serve ends the wake at once with one ERROR line; the agent stays asleep until
 * the runtime is restarted (owner decision 2026-11-24: no retry every 30 min).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError, isModelUnavailable, modelUnavailableFromResponse } from "../inference/model-unavailable.js";
import {
  MODEL_STOP_KEY,
  clearModelUnavailableOnStart,
  formatModelStop,
  readModelUnavailable,
  recordModelUnavailable,
  waitWhileModelUnavailable,
} from "../agent/model-stop.js";
import { createInferenceClient } from "../conway/inference.js";
import { runAgentLoop } from "../agent/loop.js";
import { getActivityReport, formatActivityReport } from "../state/activity-report.js";
import { insertWakeEvent } from "../state/database.js";
import { getOfflineStreak } from "../agent/offline.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const OPENAI_404 = JSON.stringify({
  error: {
    message: "The model `gpt-4.1-nano` does not exist or you do not have access to it.",
    type: "invalid_request_error", param: null, code: "model_not_found",
  },
});

describe("recognising a missing model from the provider's answer", () => {
  it("OpenAI 404 model_not_found (the tier walk's answer)", () => {
    const e = modelUnavailableFromResponse(404, OPENAI_404, "gpt-4.1-nano", "openai");
    expect(e).toBeInstanceOf(ModelUnavailableError);
    expect(e).toMatchObject({ model: "gpt-4.1-nano", provider: "openai", code: "model_not_found" });
    expect(e!.message).toBe("Model unavailable: gpt-4.1-nano (openai: model_not_found)");
    expect(e!.message).not.toContain("does not exist"); // never the response body
  });

  it("OpenAI 400 with code model_not_found, a 404 text answer, and Anthropic's not_found_error", () => {
    expect(modelUnavailableFromResponse(400, JSON.stringify({ error: { code: "model_not_found" } }), "m", "openai")?.code).toBe("model_not_found");
    expect(modelUnavailableFromResponse(404, "The model m does not exist", "m", "ollama")?.code).toBe("model_not_found");
    const anthropic = JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-x" } });
    expect(modelUnavailableFromResponse(404, anthropic, "claude-x", "anthropic")).toMatchObject({ provider: "anthropic", code: "not_found_error" });
  });

  it("other errors are not a missing model (401, 429, 500, a 404 about something else, a 400 bad request)", () => {
    expect(modelUnavailableFromResponse(401, JSON.stringify({ error: { code: "invalid_api_key" } }), "m", "openai")).toBeNull();
    expect(modelUnavailableFromResponse(429, "{}", "m", "openai")).toBeNull();
    expect(modelUnavailableFromResponse(500, OPENAI_404, "m", "openai")).toBeNull();
    expect(modelUnavailableFromResponse(404, JSON.stringify({ error: { message: "Unknown endpoint" } }), "m", "openai")).toBeNull();
    expect(modelUnavailableFromResponse(400, JSON.stringify({ error: { code: "invalid_value", message: "model param" } }), "m", "openai")).toBeNull();
    expect(isModelUnavailable(new Error("x"))).toBe(false);
  });

  it("the client raises it after one request (no retries)", async () => {
    const fetchMock = vi.fn(async () => new Response(OPENAI_404, { status: 404, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createInferenceClient({
        apiUrl: "https://unused.example", apiKey: "", defaultModel: "gpt-4.1-nano", maxTokens: 100,
        openaiApiKey: "sk-test", conwayEnabled: false,
      });
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(isModelUnavailable(err)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the stop record", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it("is recorded, shown first in agent:status, and cleared only by a restart", () => {
    expect(getActivityReport(db.raw).modelUnavailable).toBeNull();
    recordModelUnavailable(db.raw, { model: "gpt-4.1-nano", provider: "openai", code: "model_not_found" }, new Date("2026-11-24T12:00:00Z"));
    const r = getActivityReport(db.raw);
    expect(r.modelUnavailable).toMatchObject({ model: "gpt-4.1-nano", since: "2026-11-24T12:00:00.000Z" });
    const text = formatActivityReport(r);
    const lines = text.split("\n");
    expect(lines[1]).toBe(
      "!!! MODEL UNAVAILABLE since 2026-11-24 12:00:00 UTC: gpt-4.1-nano (openai: model_not_found). The agent stays asleep " +
        "until the runtime is restarted (no retries, no model calls). Fix the model in the config (modelStrategy, " +
        "agentSettings.model.allowedModels), run preflight, then restart.",
    );
    expect(text).toContain("(MODEL UNAVAILABLE: asleep until restarted)");
    expect(JSON.parse(JSON.stringify(r)).modelUnavailable.text).toBe(formatModelStop(r.modelUnavailable!));

    expect(clearModelUnavailableOnStart(db.raw)).toMatchObject({ model: "gpt-4.1-nano" });
    expect(readModelUnavailable(db.raw)).toBeNull();
    expect(clearModelUnavailableOnStart(db.raw)).toBeNull();
  });

  it("the run loop's wait ignores wake requests and never ends by itself (only when cleared)", async () => {
    recordModelUnavailable(db.raw, { model: "m", provider: "openai", code: "model_not_found" });
    let polls = 0;
    const result = await waitWhileModelUnavailable(db.raw, {
      sleep: async () => {
        polls++;
        insertWakeEvent(db.raw, "heartbeat", `tier change ${polls}`);
        if (polls === 50) db.raw.prepare("DELETE FROM kv WHERE key = ?").run(MODEL_STOP_KEY); // a restart, in effect
      },
    });
    expect(result).toEqual({ polls: 50, ignoredWakes: 49 });
  });
});

describe("agent loop with a missing model", () => {
  let db: AutomatonDatabase;
  let output: string[];
  beforeEach(() => {
    db = createTestDb();
    output = [];
    const grab = (...a: unknown[]) => { output.push(a.map(String).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(grab);
    vi.spyOn(console, "warn").mockImplementation(grab);
    vi.spyOn(console, "error").mockImplementation(grab);
    vi.spyOn(process.stdout, "write").mockImplementation(((s: any) => { output.push(String(s)); return true; }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((s: any) => { output.push(String(s)); return true; }) as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("one model call, one ERROR line, the wake ends at once, no sleep timer, asleep until restarted", async () => {
    let calls = 0;
    const inference = new MockInferenceClient([]);
    inference.chat = async () => {
      calls++;
      throw new ModelUnavailableError("gpt-4.1-nano", "openai", "model_not_found");
    };
    const turns: unknown[] = [];
    db.setKV("sleep_until", new Date(Date.now() - 1000).toISOString());
    await runAgentLoop({
      identity: createTestIdentity(), config: createTestConfig(), db, conway: new MockConwayClient(), inference,
      onTurnComplete: (t) => turns.push(t),
    });
    vi.restoreAllMocks();

    expect(calls).toBe(1); // was 5 (MAX_CONSECUTIVE_ERRORS) in the tier walk
    expect(turns).toHaveLength(0);
    const errorLines = output.filter((l) => /Model unavailable: gpt-4\.1-nano/.test(l));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(/error/i);
    expect(output.some((l) => l.includes("Turn failed"))).toBe(false);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeUndefined();
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toBe(
      "model unavailable: gpt-4.1-nano (openai: model_not_found); asleep until restarted",
    );
    expect(readModelUnavailable(db.raw)).toMatchObject({ model: "gpt-4.1-nano", provider: "openai", code: "model_not_found" });
    expect(getOfflineStreak(db.raw)).toBe(0);
  });
});
