/**
 * Fewer repeated status checks (fork, Phase 1): status in the wake-up message,
 * the latest status-only turn kept in context, repeated status calls cached.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusToolCache, buildStatusSnapshot } from "../agent/status-snapshot.js";
import { selectContextTurns } from "../agent/idle-only-tools.js";
import { buildWakeupPrompt } from "../agent/system-prompt.js";
import { getWakeStart, recordWakeEnd, recordWakeStart } from "../agent/wake-state.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase, FinancialState, ToolCallResult } from "../types.js";

const financial: FinancialState = {
  creditsCents: 450,
  usdcBalance: 2,
  lastChecked: new Date().toISOString(),
} as FinancialState;

const budget = { dailySpentMc: 6000, dailyCapCents: 100, lifetimeSpentMc: 6000, lifetimeCapCents: 500 };

describe("status in the wake-up message", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("snapshot shows balance, tier, budget and says no status tool is needed", () => {
    const s = buildStatusSnapshot({ config: createTestConfig(), financial, db, budget });
    expect(s).toContain("Survival tier:");
    expect(s).toContain("Inference today: $0.06 of $1.00 cap");
    expect(s).toContain("Inference lifetime: $0.06 of $5.00 cap");
    expect(s).toMatch(/do not need check_balance, system_synopsis/);
  });

  it("says what is already done: soul version and why the last wake ended", () => {
    const before = buildStatusSnapshot({ config: createTestConfig(), financial, db, budget });
    expect(before).toContain("SOUL.md: not written yet (write it with update_soul)");
    expect(before).not.toContain("Last wake ended");

    db.raw.prepare(
      "INSERT INTO soul_history (id, version, content, content_hash, change_source, created_at) VALUES ('h5', 5, 'x', 'h', 'agent', '2026-11-16T10:00:00.000Z')",
    ).run();
    recordWakeEnd(db.raw, "cycle limit (25 turns)", new Date("2026-11-16T11:22:33Z"));
    const after = buildStatusSnapshot({ config: createTestConfig(), financial, db, budget });
    expect(after).toContain("SOUL.md: exists, version 5, last updated 2026-11-16");
    expect(after).toContain("Last wake ended: cycle limit (25 turns) (2026-11-16 11:22 UTC)");
  });

  it("records the wake start time", () => {
    const iso = recordWakeStart(db.raw, new Date("2026-11-16T09:00:00Z"));
    expect(getWakeStart(db.raw)).toBe(iso);
  });

  it("first-run and later wake-up messages carry the status and do not ask for checks", () => {
    const first = buildWakeupPrompt({ identity: createTestIdentity(), config: createTestConfig(), financial, db, budget });
    expect(first).toContain("--- STATUS (current");
    expect(first).not.toMatch(/Survey your environment|Review your financial situation/);

    db.insertTurn({
      id: "t1", timestamp: new Date().toISOString(), state: "running", input: "x", inputSource: "wakeup",
      thinking: "done", toolCalls: [], tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, costCents: 0,
    } as any);
    const later = buildWakeupPrompt({ identity: createTestIdentity(), config: createTestConfig(), financial, db, budget });
    expect(later).toContain("--- STATUS (current");
    expect(later).not.toMatch(/Check your balance, heartbeat status/);
  });
});

describe("selectContextTurns", () => {
  const turn = (id: string, ...tools: string[]) => ({ id, toolCalls: tools.map((name) => ({ name })) });

  it("drops status-only turns except the most recent one", () => {
    const turns = [
      turn("a", "system_synopsis"),
      turn("b", "write_file"),
      turn("c", "check_usdc_balance"),
      turn("d"),
      turn("e", "system_synopsis", "list_skills"),
    ];
    expect(selectContextTurns(turns).map((t) => t.id)).toEqual(["b", "d", "e"]);
  });

  it("keeps everything when nothing is status-only", () => {
    const turns = [turn("a", "exec"), turn("b")];
    expect(selectContextTurns(turns).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("StatusToolCache", () => {
  const res = (name: string, result: string, args: Record<string, unknown> = {}): ToolCallResult => ({
    id: "x", name, arguments: args, result, durationMs: 5,
  });

  it("answers a repeated status call from the cache with a note", () => {
    const c = new StatusToolCache();
    expect(c.lookup("1", "check_balance", {})).toBeUndefined();
    c.record(res("check_balance", "Balance: $4.50"));
    const hit = c.lookup("2", "check_balance", {});
    expect(hit?.id).toBe("2");
    expect(hit?.result).toContain("Balance: $4.50");
    expect(hit?.result).toMatch(/Unchanged/);
  });

  it("any other tool call clears the cache", () => {
    const c = new StatusToolCache();
    c.record(res("system_synopsis", "ok"));
    c.record(res("update_soul", "saved"));
    expect(c.lookup("2", "system_synopsis", {})).toBeUndefined();
  });

  it("does not cache errors, other tools, or expired entries; args are part of the key", () => {
    let now = 0;
    const c = new StatusToolCache(1000, () => now);
    c.record({ ...res("check_balance", ""), error: "rpc down" });
    expect(c.lookup("2", "check_balance", {})).toBeUndefined();
    c.record(res("read_file", "content", { path: "a" }));
    expect(c.lookup("2", "read_file", { path: "a" })).toBeUndefined();
    c.record(res("check_inference_spending", "x", { days: 1 }));
    expect(c.lookup("2", "check_inference_spending", { days: 2 })).toBeUndefined();
    expect(c.lookup("2", "check_inference_spending", { days: 1 })).toBeDefined();
    now = 1001;
    expect(c.lookup("2", "check_inference_spending", { days: 1 })).toBeUndefined();
  });
});
