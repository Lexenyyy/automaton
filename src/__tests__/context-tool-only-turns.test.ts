/**
 * Fork, run 5 retry (G1): turns whose model reply had tool calls but no text
 * (normal for gpt-4.1-mini) must still be shown to the model, with their
 * tool results. Before, they were left out, so within a wake the model never
 * saw what it had already done and repeated itself until the turn cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContextMessages } from "../agent/context.js";
import { createInferenceClient } from "../conway/inference.js";
import type { AgentTurn } from "../types.js";

function turn(overrides: Partial<AgentTurn>): AgentTurn {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-11-17T18:20:39.777Z",
    state: "running",
    input: undefined,
    inputSource: undefined,
    thinking: "",
    toolCalls: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costCents: 0,
    ...overrides,
  } as AgentTurn;
}

describe("context with tool-only turns", () => {
  it("renders the assistant tool calls and their results when the turn has no text", () => {
    const turns = [
      turn({
        input: "You are waking up.",
        inputSource: "wakeup",
        toolCalls: [{ id: "call_1", name: "view_soul", arguments: {}, result: "Format: soul/v1 v88", durationMs: 1 }],
      }),
      turn({
        toolCalls: [{ id: "call_2", name: "update_soul", arguments: { section: "values" }, result: "", durationMs: 0, error: "Policy denied: RATE_LIMIT_SOUL" }],
      }),
    ];
    const messages = buildContextMessages("SYSTEM", turns);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool"]);
    expect(messages[2]).toMatchObject({ content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "view_soul", arguments: "{}" } }] });
    expect(messages[3]).toMatchObject({ tool_call_id: "call_1", content: "Format: soul/v1 v88" });
    expect(messages[5]).toMatchObject({ tool_call_id: "call_2", content: "Error: Policy denied: RATE_LIMIT_SOUL" });
  });

  it("a turn with neither text nor tool calls adds no assistant message", () => {
    const messages = buildContextMessages("SYSTEM", [turn({ input: "hi", inputSource: "system" })]);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("OpenAI request for a tool-only assistant message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends content null with the tool calls; other messages unchanged", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init?: any) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      openaiApiKey: "test-key",
      defaultModel: "gpt-4.1-mini",
      maxTokens: 100,
      conwayEnabled: false,
    });
    await client.chat([
      { role: "user", content: "wake" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "view_soul", arguments: "{}" } }] },
      { role: "tool", content: "", tool_call_id: "c1" },
      { role: "assistant", content: "" },
    ]);
    expect(sent.messages[1]).toMatchObject({ role: "assistant", content: null, tool_calls: [{ id: "c1" }] });
    expect(sent.messages[2]).toMatchObject({ role: "tool", content: "" });
    expect(sent.messages[3]).toMatchObject({ role: "assistant", content: "" });
  });
});
