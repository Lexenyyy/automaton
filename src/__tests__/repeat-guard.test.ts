/**
 * Repeat guard: force sleep early on repeated failures or no-progress repeats,
 * and sleep 30 minutes after a forced stop (fork, run 3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepeatGuard, isFailedToolCall, resolveLoopGuard } from "../agent/repeat-guard.js";
import { runAgentLoop } from "../agent/loop.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";
import type { AgentTurn, AutomatonDatabase, ToolCallResult } from "../types.js";

const res = (name: string, args: Record<string, unknown>, result: string, error?: string): ToolCallResult => ({
  id: "x", name, arguments: args, result, durationMs: 1, ...(error ? { error } : {}),
});

describe("RepeatGuard", () => {
  it("trips on the 3rd failure of the same tool, any arguments", () => {
    const g = new RepeatGuard(3);
    expect(g.record(res("write_file", { path: "/a/SOUL.md" }, "Blocked: Cannot overwrite protected file."))).toBeUndefined();
    expect(g.record(res("write_file", { path: "/b/SOUL.md" }, "Blocked: Cannot overwrite protected file."))).toBeUndefined();
    expect(g.record(res("write_file", { path: "/c/SOUL.md" }, "Blocked: Cannot overwrite protected file.")))
      .toMatch(/^write_file failed 3× this wake \(last: "Blocked: Cannot overwrite/);
  });

  it("counts policy denials and tool errors as failures; other tools have their own count", () => {
    const g = new RepeatGuard(3);
    g.record(res("update_soul", {}, "", "Policy denied: RATE_LIMIT_SOUL — limit"));
    g.record(res("read_file", { path: "x" }, "ERROR: File not found or not readable: x"));
    expect(g.record(res("update_soul", { a: 2 }, "", "Policy denied: RATE_LIMIT_SOUL — limit"))).toBeUndefined();
    expect(g.record(res("update_soul", { a: 3 }, "", "boom"))).toMatch(/update_soul failed 3×/);
  });

  it("trips on 3 identical calls with identical results (no progress)", () => {
    const g = new RepeatGuard(3);
    g.record(res("exec", { command: "ls" }, "a.txt"));
    g.record(res("exec", { command: "ls" }, "a.txt"));
    expect(g.record(res("exec", { command: "ls" }, "a.txt"))).toMatch(/exec called 3× with the same arguments and the same result/);
  });

  it("does not trip when the same command gives a different result (e.g. tests rerun after an edit)", () => {
    const g = new RepeatGuard(3);
    expect(g.record(res("exec", { command: "pnpm test" }, "2 failed"))).toBeUndefined();
    expect(g.record(res("exec", { command: "pnpm test" }, "1 failed"))).toBeUndefined();
    expect(g.record(res("exec", { command: "pnpm test" }, "0 failed"))).toBeUndefined();
    expect(g.record(res("exec", { command: "pnpm test" }, "0 failed"))).toBeUndefined(); // 2nd identical
  });

  it("0 turns the guard off", () => {
    const g = new RepeatGuard(0);
    for (let i = 0; i < 5; i++) expect(g.record(res("x", {}, "Blocked: no"))).toBeUndefined();
  });

  it("failure detection", () => {
    expect(isFailedToolCall({ result: "Blocked: x" })).toBe(true);
    expect(isFailedToolCall({ result: "  ERROR: x" })).toBe(true);
    expect(isFailedToolCall({ result: "", error: "Policy denied: X" })).toBe(true);
    expect(isFailedToolCall({ result: "File written: /root/a" })).toBe(false);
  });

  it("settings: defaults 3 and 30 minutes; invalid values fall back", () => {
    expect(resolveLoopGuard({})).toEqual({ maxRepeats: 3, forcedSleepMinutes: 30 });
    expect(resolveLoopGuard({ loopGuard: { maxRepeats: 5, forcedSleepMinutes: 10 } })).toEqual({ maxRepeats: 5, forcedSleepMinutes: 10 });
    expect(resolveLoopGuard({ loopGuard: { maxRepeats: 0 } }).maxRepeats).toBe(0);
    expect(resolveLoopGuard({ loopGuard: { maxRepeats: -1, forcedSleepMinutes: 0 } })).toEqual({ maxRepeats: 3, forcedSleepMinutes: 30 });
    expect(resolveLoopGuard({ loopGuard: { maxRepeats: 2.5, forcedSleepMinutes: 99999 } })).toEqual({ maxRepeats: 3, forcedSleepMinutes: 30 });
  });
});

describe("agent loop with the repeat guard", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const run = async (responses: ReturnType<typeof toolCallResponse>[], config = createTestConfig()) => {
    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity: createTestIdentity(),
      config,
      db,
      conway,
      inference: new MockInferenceClient(responses),
      onTurnComplete: (t) => turns.push(t),
    });
    return turns;
  };

  it("3 blocked write_file SOUL.md calls force a 30-minute sleep instead of running to the turn limit", async () => {
    const write = () => toolCallResponse([{ name: "write_file", arguments: { path: "/root/.automaton/SOUL.md", content: "x" } }]);
    const turns = await run([write(), write(), write(), write(), write(), noToolResponse("done")]);

    expect(turns).toHaveLength(3);
    expect(db.getAgentState()).toBe("sleeping");
    const sleepMs = new Date(db.getKV("sleep_until")!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(29 * 60_000);
    expect(sleepMs).toBeLessThan(31 * 60_000);
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toMatch(/^forced sleep: write_file failed 3× this wake/);
  });

  it("3 identical exec calls with identical results force sleep; the owner's sleep length is used", async () => {
    const same = () => toolCallResponse([{ name: "exec", arguments: { command: "echo same" } }]);
    const turns = await run([same(), same(), same(), same(), noToolResponse("done")], createTestConfig({ loopGuard: { forcedSleepMinutes: 5 } }));

    expect(turns).toHaveLength(3);
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toMatch(/exec called 3× with the same arguments and the same result/);
    const sleepMs = new Date(db.getKV("sleep_until")!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(4 * 60_000);
    expect(sleepMs).toBeLessThan(6 * 60_000);
  });
});
