/**
 * Per-wake limit on soul updates: policy rule rate.soul_per_wake
 * (fork, run 3; owner-approved under rule 4, only tightens).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { recordWakeStart } from "../agent/wake-state.js";
import { DEFAULT_SOUL_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "soul-limit-"));
  process.env.HOME = home;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const tools = createBuiltinTools("test-sandbox-id");

function setup(config: AutomatonConfig = createTestConfig()) {
  const ctx: ToolContext = {
    identity: createTestIdentity(),
    config,
    db,
    conway: new MockConwayClient(),
    inference: new MockInferenceClient(),
  };
  const engine = new PolicyEngine(db.raw, createDefaultRules(DEFAULT_TREASURY_POLICY));
  const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
  const update = (n: number) =>
    executeTool(
      "update_soul",
      // strategy: corePurpose is owner-only by default (G3, soul-owner-only.test.ts).
      { section: "strategy", content: `Test strategy ${n}.`, reason: `test ${n}` },
      tools,
      ctx,
      engine,
      turn,
    );
  return { update };
}

describe("rate.soul_per_wake", () => {
  it("default 2 per wake: the 3rd update in the same wake is denied with a clear message", async () => {
    expect(DEFAULT_SOUL_CONFIG.maxUpdatesPerWake).toBe(2);
    recordWakeStart(db.raw);
    const { update } = setup();
    expect((await update(1)).error).toBeUndefined();
    expect((await update(2)).error).toBeUndefined();
    const third = await update(3);
    expect(third.error).toMatch(/^Policy denied: RATE_LIMIT_SOUL — Soul already updated 2 times this wake \(max 2 per wake\)/);
    const versions = db.raw.prepare("SELECT COUNT(*) AS n FROM soul_history").get() as { n: number };
    expect(versions.n).toBe(2);
  });

  it("a new wake starts at zero", async () => {
    recordWakeStart(db.raw, new Date(Date.now() - 60_000));
    const { update } = setup();
    await update(1);
    await update(2);
    expect((await update(3)).error).toMatch(/RATE_LIMIT_SOUL/);
    recordWakeStart(db.raw, new Date(Date.now() + 1000)); // next wake
    await new Promise((r) => setTimeout(r, 1100));
    expect((await update(4)).error).toBeUndefined();
  });

  it("owner setting: 1 per wake, or 0 = no limit", async () => {
    recordWakeStart(db.raw);
    const one = setup(createTestConfig({ soulConfig: { ...DEFAULT_SOUL_CONFIG, maxUpdatesPerWake: 1 } }));
    expect((await one.update(1)).error).toBeUndefined();
    expect((await one.update(2)).error).toMatch(/max 1 per wake/);

    const unlimited = setup(createTestConfig({ soulConfig: { ...DEFAULT_SOUL_CONFIG, maxUpdatesPerWake: 0 } }));
    for (let i = 3; i < 7; i++) expect((await unlimited.update(i)).error).toBeUndefined();
  });

  it("only counts the agent's own updates", async () => {
    recordWakeStart(db.raw);
    for (const [id, src] of [["h1", "human"], ["h2", "system"], ["h3", "reflection"]]) {
      db.raw.prepare(
        "INSERT INTO soul_history (id, version, content, content_hash, change_source, created_at) VALUES (?, ?, 'x', 'h', ?, ?)",
      ).run(id, Number(id.slice(1)), src, new Date().toISOString());
    }
    const { update } = setup();
    expect((await update(1)).error).toBeUndefined();
  });
});
