/**
 * Tool allowlist and smaller system prompt (fork, Phase 1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkToolAllowlist,
  filterToolsForAllowlist,
  resolveToolAllowlist,
} from "../agent/tool-allowlist.js";
import { createBuiltinTools } from "../agent/tools.js";
import { filterToolsForConwayMode } from "../conway/mode.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const builtins = createBuiltinTools("sandbox");

describe("toolAllowlist", () => {
  it("absent = all tools; set = only those (and therefore only those executable)", () => {
    expect(resolveToolAllowlist({})).toBeNull();
    expect(filterToolsForAllowlist(builtins, null)).toHaveLength(builtins.length);
    const allow = resolveToolAllowlist({ toolAllowlist: [" sleep ", "exec", "exec", ""] });
    expect([...allow!]).toEqual(["sleep", "exec"]);
    expect(filterToolsForAllowlist(builtins, allow).map((t) => t.name).sort()).toEqual(["exec", "sleep"]);
  });

  it("check: unknown or hidden names and a missing sleep are problems", () => {
    const available = filterToolsForConwayMode(builtins, "off");
    expect(checkToolAllowlist(null, available)).toEqual([]);
    expect(checkToolAllowlist(new Set(["sleep", "exec"]), available)).toEqual([]);
    const p = checkToolAllowlist(new Set(["exec", "no_such_tool", "transfer_credits"]), available);
    expect(p.join("\n")).toContain("no_such_tool, transfer_credits");
    expect(p.join("\n")).toContain('must include "sleep"');
  });
  // The Docker template's own allowlist is checked by agent:verify
  // ("--preflight passes"): startup refuses an invalid one.
});

describe("system prompt size", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("does not repeat tool descriptions (they are in the tool definitions); keeps the risk marker", () => {
    const p = buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig({ genesisPrompt: "GENESIS-MARK" }),
      financial: { creditsCents: 500, usdcBalance: 5, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: builtins,
      isFirstRun: false,
    });
    expect(p).not.toContain("--- AVAILABLE TOOLS ---");
    const writeFile = builtins.find((t) => t.name === "write_file")!;
    expect(p).not.toContain(writeFile.description);
    const risky = builtins.filter((t) => t.riskLevel === "dangerous" || t.riskLevel === "forbidden");
    if (risky.length) expect(p).toContain(`Dangerous tools (use with care): ${risky[0].name}`);
    // Fixed layers come before the changing status block.
    expect(p.indexOf("GENESIS-MARK")).toBeLessThan(p.indexOf("--- CURRENT STATUS ---"));
    expect(p.indexOf("<environment>")).toBeLessThan(p.indexOf("--- CURRENT STATUS ---"));
  });
});
