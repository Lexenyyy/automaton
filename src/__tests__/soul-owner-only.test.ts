/**
 * Fork, run 5 retry (G3; owner-requested, only tightens): soul sections in
 * soulConfig.ownerOnlySections (default corePurpose) are denied to the
 * agent's update_soul by policy rule authority.soul_owner_only. The owner
 * changes them with the config template and agent:soul:reset.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { checkSoulDefaults, resetSoul, soulReport } from "../soul/reset.js";
import { checkOwnerOnlySoulSections, resolveOwnerOnlySoulSections } from "../soul/sections.js";
import { DEFAULT_SOUL_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "soul-owner-"));
  process.env.HOME = home;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const tools = createBuiltinTools("test-sandbox-id");
const withSections = (ownerOnlySections: unknown) =>
  createTestConfig({ soulConfig: { ...DEFAULT_SOUL_CONFIG, ownerOnlySections } as any });

function updater(config: AutomatonConfig = createTestConfig()) {
  const ctx: ToolContext = {
    identity: createTestIdentity(),
    config,
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
  const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY));
  const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
  return (section: string, content: string) =>
    executeTool("update_soul", { section, content, reason: "test" }, tools, ctx, engine, turn);
}

const versions = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM soul_history").get() as { n: number }).n;

describe("authority.soul_owner_only", () => {
  it("default: corePurpose is denied with a clear message and nothing is written; other sections work", async () => {
    expect(DEFAULT_SOUL_CONFIG.ownerOnlySections).toEqual(["corePurpose"]);
    const update = updater();
    const denied = await update("corePurpose", "I optimize my resources.");
    expect(denied.error).toBe(
      'Policy denied: OWNER_ONLY_SOUL_SECTION — The soul section "corePurpose" is set by your owner only; you cannot change it. ' +
        "You may update: values, behavioralGuidelines, personality, boundaries, strategy. Don't retry.",
    );
    expect(versions()).toBe(0);
    expect((await update("strategy", "Sleep early.")).error).toBeUndefined();
    expect(versions()).toBe(1);
    const decision = db.raw
      .prepare("SELECT decision, rules_triggered FROM policy_decisions WHERE tool_name = 'update_soul' AND decision = 'deny'")
      .get() as { decision: string; rules_triggered: string } | undefined;
    expect(decision?.rules_triggered).toContain("authority.soul_owner_only");
  });

  it("owner setting: [] lets the agent change corePurpose; a longer list keeps more sections", async () => {
    expect((await updater(withSections([]))("corePurpose", "New purpose.")).error).toBeUndefined();
    const update = updater(withSections(["corePurpose", "values"]));
    expect((await update("values", "- a")).error).toMatch(/"values" is set by your owner only.*You may update: behavioralGuidelines, personality, boundaries, strategy\./);
    expect((await update("strategy", "x")).error).toBeUndefined();
  });

  it("startup refuses unknown section names; unset means the default", () => {
    expect(checkOwnerOnlySoulSections(undefined)).toBeNull();
    expect(checkOwnerOnlySoulSections([])).toBeNull();
    expect(checkOwnerOnlySoulSections(["corePurpose", "values"])).toBeNull();
    for (const bad of [["name"], ["corePurpose", 3], "corePurpose", {}]) {
      expect(checkOwnerOnlySoulSections(bad)).toMatch(/soulConfig.ownerOnlySections must be a list of soul sections/);
    }
    expect(checkSoulDefaults({ soulConfig: { ownerOnlySections: ["purpose"] } as any })).toHaveLength(1);
    expect(resolveOwnerOnlySoulSections(createTestConfig({ soulConfig: { ...DEFAULT_SOUL_CONFIG, ownerOnlySections: undefined } }))).toEqual(["corePurpose"]);
    expect(resolveOwnerOnlySoulSections(undefined)).toEqual(["corePurpose"]);
  });

  it("the owner reset still sets the purpose, and the owner view names the owner-only sections", () => {
    const soulPath = path.join(home, "SOUL.md");
    const config = createTestConfig({ soulConfig: { ...DEFAULT_SOUL_CONFIG, defaultCorePurpose: "Owner's purpose." } });
    const identity = { name: "a", address: "0xAbC0000000000000000000000000000000000001", creator: "0xDef0000000000000000000000000000000000002" };
    expect(resetSoul(db.raw, config, identity, soulPath).success).toBe(true);
    const report = soulReport(db.raw, soulPath, config);
    expect(report).toContain("Core purpose: Owner's purpose.");
    expect(report).toContain("Owner-only sections: corePurpose (the agent cannot change them; edit soulConfig and run agent:soul:reset)");
    expect(soulReport(db.raw, soulPath, withSections([]))).toContain("Owner-only sections: none");
  });
});
