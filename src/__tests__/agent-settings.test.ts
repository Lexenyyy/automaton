/**
 * Fork Phase 1: settings the agent changes itself are stored in the database
 * within the owner's limits; the config file is never written by the agent.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAgentSettings,
  resetAgentSettings,
  resolveSettingsLimits,
  setGenesisPromptByAgent,
  setInferenceModelByAgent,
  settingsReport,
} from "../agent/settings.js";
import { createBuiltinTools } from "../agent/tools.js";
import { ModelRegistry } from "../inference/registry.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG, type AutomatonConfig } from "../types.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient, MockInferenceClient } from "./mocks.js";

const DAY1 = new Date("2026-11-12T10:00:00Z");
const DAY1_LATER = new Date("2026-11-12T23:59:00Z");
const DAY2 = new Date("2026-11-13T00:01:00Z");

function config(overrides: Partial<AutomatonConfig> = {}): AutomatonConfig {
  return createTestConfig({
    genesisPrompt: "Owner genesis prompt.",
    inferenceModel: "gpt-4.1-mini",
    modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG },
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("owner limits", () => {
  it("defaults: genesis changes off, model changes on for the three strategy models only", () => {
    const limits = resolveSettingsLimits(config());
    expect(limits.genesisPrompt).toEqual({ allowAgentChanges: false, maxChangesPerDay: 1, maxLength: 2000 });
    expect(limits.model).toEqual({ allowAgentChanges: true, allowedModels: ["gpt-4.1-mini", "gpt-4.1-nano"], maxChangesPerDay: 4 });
  });

  it("uses the owner's explicit values, and never allows more than 2000 characters", () => {
    const limits = resolveSettingsLimits(
      config({
        agentSettings: {
          genesisPrompt: { allowAgentChanges: true, maxChangesPerDay: 2, maxLength: 50_000 },
          model: { allowAgentChanges: false, allowedModels: ["gpt-4.1-nano"], maxChangesPerDay: 0 },
        },
      }),
    );
    expect(limits.genesisPrompt).toEqual({ allowAgentChanges: true, maxChangesPerDay: 2, maxLength: 2000 });
    expect(limits.model).toEqual({ allowAgentChanges: false, allowedModels: ["gpt-4.1-nano"], maxChangesPerDay: 0 });
  });

  it("ignores invalid limit values (falls back to the safe defaults)", () => {
    const limits = resolveSettingsLimits(
      config({ agentSettings: { genesisPrompt: { allowAgentChanges: "yes" as any, maxChangesPerDay: -1 } } }),
    );
    expect(limits.genesisPrompt.allowAgentChanges).toBe(false);
    expect(limits.genesisPrompt.maxChangesPerDay).toBe(1);
  });
});

describe("genesis prompt", () => {
  it("is refused by default and nothing is stored", () => {
    const c = config();
    const db = createTestDb();
    const r = setGenesisPromptByAgent(c, db.raw, "New purpose.", "why", DAY1);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("allowAgentChanges") });
    expect(c.genesisPrompt).toBe("Owner genesis prompt.");
    expect(db.raw.prepare("SELECT COUNT(*) n FROM agent_settings").get()).toEqual({ n: 0 });
  });

  it("when allowed: stored, applied in memory, limited per UTC day and by length", () => {
    const c = config({ agentSettings: { genesisPrompt: { allowAgentChanges: true, maxLength: 20 } } });
    const db = createTestDb();
    expect(setGenesisPromptByAgent(c, db.raw, "x".repeat(21), "too long", DAY1).ok).toBe(false);
    expect(setGenesisPromptByAgent(c, db.raw, "First change.", "r1", DAY1)).toMatchObject({ ok: true });
    expect(c.genesisPrompt).toBe("First change.");
    expect(setGenesisPromptByAgent(c, db.raw, "Second.", "r2", DAY1_LATER)).toEqual({
      ok: false,
      error: expect.stringContaining("daily limit reached (1/1"),
    });
    expect(setGenesisPromptByAgent(c, db.raw, "Next day.", "r3", DAY2)).toMatchObject({ ok: true });
    expect(db.raw.prepare("SELECT value FROM agent_settings WHERE key='genesis_prompt'").get()).toEqual({ value: "Next day." });
  });
});

describe("inference model", () => {
  it("allows only the owner's models and can always switch back to the owner's model", () => {
    const c = config();
    const db = createTestDb();
    expect(setInferenceModelByAgent(c, db.raw, "gpt-5-mini", "want bigger", DAY1)).toEqual({
      ok: false,
      error: expect.stringContaining("not in the owner's allowed models"),
    });
    expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-nano", "save money", DAY1).ok).toBe(true);
    expect(c.inferenceModel).toBe("gpt-4.1-nano");
    expect(c.modelStrategy!.inferenceModel).toBe("gpt-4.1-nano");
    // The allowlist comes from the owner's original config, not the changed one.
    expect(resolveSettingsLimits(c).model.allowedModels).toEqual(["gpt-4.1-mini", "gpt-4.1-nano"]);
    expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-mini", "back", DAY1).ok).toBe(true);
  });

  it("has a daily limit", () => {
    const c = config();
    const db = createTestDb();
    for (let i = 0; i < 4; i++) {
      expect(setInferenceModelByAgent(c, db.raw, i % 2 ? "gpt-4.1-mini" : "gpt-4.1-nano", "r", DAY1).ok).toBe(true);
    }
    expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-nano", "r", DAY1_LATER)).toEqual({
      ok: false,
      error: expect.stringContaining("daily limit reached (4/4"),
    });
    expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-nano", "r", DAY2).ok).toBe(true);
  });

  it("is refused when the owner turned model changes off", () => {
    const c = config({ agentSettings: { model: { allowAgentChanges: false } } });
    const db = createTestDb();
    expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-nano", "r", DAY1).ok).toBe(false);
    expect(c.inferenceModel).toBe("gpt-4.1-mini");
  });
});

describe("startup and owner commands", () => {
  it("applies stored values that still meet the owner's current limits", () => {
    const db = createTestDb();
    const before = config({ agentSettings: { genesisPrompt: { allowAgentChanges: true } } });
    setGenesisPromptByAgent(before, db.raw, "Agent purpose.", "r", DAY1);
    setInferenceModelByAgent(before, db.raw, "gpt-4.1-nano", "r", DAY1);

    const restart = config({ agentSettings: { genesisPrompt: { allowAgentChanges: true } } });
    expect(applyAgentSettings(restart, db.raw)).toEqual({ applied: ["genesis_prompt", "inference_model"], ignored: [] });
    expect(restart.genesisPrompt).toBe("Agent purpose.");
    expect(restart.inferenceModel).toBe("gpt-4.1-nano");
  });

  it("ignores stored values once the owner tightens the limits", () => {
    const db = createTestDb();
    const before = config({ agentSettings: { genesisPrompt: { allowAgentChanges: true } } });
    setGenesisPromptByAgent(before, db.raw, "Agent purpose.", "r", DAY1);
    setInferenceModelByAgent(before, db.raw, "gpt-4.1-nano", "r", DAY1);

    const tightened = config({ agentSettings: { model: { allowedModels: ["gpt-4.1-mini"] } } });
    const result = applyAgentSettings(tightened, db.raw);
    expect(result.applied).toEqual([]);
    expect(result.ignored.map((i) => i.key)).toEqual(["genesis_prompt", "inference_model"]);
    expect(tightened.genesisPrompt).toBe("Owner genesis prompt.");
    expect(tightened.inferenceModel).toBe("gpt-4.1-mini");
    expect(settingsReport(tightened, db.raw, DAY1)).toContain("agent value ignored");
  });

  it("reset removes the agent's values and keeps an append-only history", () => {
    const db = createTestDb();
    const c = config();
    setInferenceModelByAgent(c, db.raw, "gpt-4.1-nano", "r", DAY1);
    expect(resetAgentSettings(db.raw, DAY1)).toEqual(["inference_model"]);
    expect(resetAgentSettings(db.raw, DAY1)).toEqual([]);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM agent_settings").get()).toEqual({ n: 0 });
    const history = db.raw.prepare("SELECT key, actor FROM agent_settings_changes ORDER BY id").all();
    expect(history).toEqual([
      { key: "inference_model", actor: "agent" },
      { key: "inference_model", actor: "owner" },
    ]);
    expect(() => db.raw.prepare("UPDATE agent_settings_changes SET value = 'x'").run()).toThrow(/append-only/);
    expect(() => db.raw.prepare("DELETE FROM agent_settings_changes").run()).toThrow(/append-only/);
    // Reset is by the owner, so it does not count against the agent's daily limit.
    for (let i = 0; i < 3; i++) expect(setInferenceModelByAgent(c, db.raw, "gpt-4.1-mini", "r", DAY1).ok).toBe(true);
  });

  it("only known keys can be stored", () => {
    const db = createTestDb();
    expect(() => db.raw.prepare("INSERT INTO agent_settings (key, value) VALUES ('treasury_policy', '{}')").run()).toThrow(
      /CHECK constraint/,
    );
  });
});

describe("the two tools never write the config file", () => {
  function tools() {
    const all = createBuiltinTools("sbx");
    return {
      genesis: all.find((t) => t.name === "update_genesis_prompt")!,
      model: all.find((t) => t.name === "switch_model")!,
    };
  }

  it("update_genesis_prompt: refused by default; when allowed, stored in the database", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const db = createTestDb();
    const ctxFor = (c: AutomatonConfig) => ({
      identity: createTestIdentity(),
      config: c,
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    });
    const { genesis } = tools();

    const off = config();
    expect(await genesis.execute({ new_prompt: "New.", reason: "r" }, ctxFor(off))).toContain("allowAgentChanges");
    expect(off.genesisPrompt).toBe("Owner genesis prompt.");

    const on = config({ agentSettings: { genesisPrompt: { allowAgentChanges: true } } });
    expect(await genesis.execute({ new_prompt: "New purpose.", reason: "r" }, ctxFor(on))).toContain("stored in the database");
    expect(on.genesisPrompt).toBe("New purpose.");
    expect(db.getKV("genesis_prompt_backup")).toBe("Owner genesis prompt.");
    expect(writeSpy.mock.calls.some(([p]) => /automaton\.json$/.test(String(p)))).toBe(false);
  });

  it("switch_model: allowlist enforced, stored in the database", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const db = createTestDb();
    new ModelRegistry(db.raw).initialize();
    const c = config();
    const ctx = { identity: createTestIdentity(), config: c, db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const { model } = tools();

    expect(await model.execute({ model_id: "gpt-5-mini", reason: "r" }, ctx)).toContain("not in the owner's allowed models");
    expect(await model.execute({ model_id: "gpt-4.1-nano", reason: "r" }, ctx)).toContain("stored in the database");
    expect(c.inferenceModel).toBe("gpt-4.1-nano");
    expect(writeSpy.mock.calls.some(([p]) => /automaton\.json$/.test(String(p)))).toBe(false);
  });

  it("no agent code references saveConfig (only setup, provisioning and config.ts)", () => {
    const SRC = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(full);
        } else if (/\.ts$/.test(e.name) && /\bsaveConfig\b/.test(fs.readFileSync(full, "utf-8"))) {
          hits.push(path.relative(SRC, full).split(path.sep).join("/"));
        }
      }
    };
    walk(SRC);
    expect(hits.sort()).toEqual(["config.ts", "identity/provision.ts", "setup/configure.ts", "setup/model-picker.ts", "setup/wizard.ts"]);
  });
});
