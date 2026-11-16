/**
 * Orchestration on/off (fork, Phase 1): with "off", no orchestration prompt
 * and goal/child tools hidden; with "on", the prompt says to do simple tasks
 * directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ORCHESTRATION_TOOLS,
  filterToolsForOrchestration,
  resolveOrchestrationMode,
} from "../agent/orchestration-mode.js";
import { createBuiltinTools } from "../agent/tools.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

const builtins = createBuiltinTools("sandbox");

describe("orchestration mode", () => {
  it("absent means on (upstream behavior); only \"off\" turns it off", () => {
    expect(resolveOrchestrationMode({})).toBe("on");
    expect(resolveOrchestrationMode({ orchestration: "on" })).toBe("on");
    expect(resolveOrchestrationMode({ orchestration: "off" })).toBe("off");
  });

  it("off hides every goal and child tool (so they are not executable); on keeps all", () => {
    const names = builtins.map((t) => t.name);
    for (const n of ORCHESTRATION_TOOLS) expect(names).toContain(n);
    const off = filterToolsForOrchestration(builtins, "off").map((t) => t.name);
    expect(off.filter((n) => ORCHESTRATION_TOOLS.has(n))).toEqual([]);
    expect(off.length).toBe(builtins.length - ORCHESTRATION_TOOLS.size);
    expect(filterToolsForOrchestration(builtins, "on")).toHaveLength(builtins.length);
    for (const keep of ["update_soul", "write_file", "exec", "sleep", "check_balance"]) expect(off).toContain(keep);
  });
});

describe("system prompt and orchestration", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  const prompt = (config: AutomatonConfig) =>
    buildSystemPrompt({
      identity: createTestIdentity(),
      config,
      financial: { creditsCents: 500, usdcBalance: 5, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: filterToolsForOrchestration(builtins, resolveOrchestrationMode(config)),
      isFirstRun: true,
    });

  it("off: no orchestration or turn protocol, no goal tools, work directly", () => {
    const p = prompt(createTestConfig({ orchestration: "off" }));
    expect(p).not.toContain("<orchestration>");
    expect(p).not.toContain("<turn_protocol>");
    expect(p).not.toContain("create_goal");
    expect(p).not.toContain("--- ORCHESTRATOR STATUS ---");
    expect(p).toContain("<environment>");
    expect(p).toContain("<persistence>");
    expect(p).toContain("Do your work directly with your tools.");
  });

  it("on: simple tasks directly, goals only for multi-step work; no 'MUST delegate everything'", () => {
    const p = prompt(createTestConfig({ orchestration: "on" }));
    expect(p).toContain("<orchestration>");
    expect(p).toContain("FIRST DECIDE: DIRECT OR GOAL?");
    expect(p).toContain("call update_soul directly. No goal.");
    expect(p).not.toContain("The ONLY work you do directly is");
    expect(p).not.toContain("DO NOT write code yourself");
  });
});
