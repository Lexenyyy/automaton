/**
 * Survival tier settings (fork, Phase 4 step 2): config.survival.
 * Owner requirements: defaults equal the old hardcoded values exactly; startup
 * refuses thresholds out of order; deadGraceMinutes minimum 1.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_SURVIVAL_SETTINGS,
  checkSurvivalSettings,
  resolveSurvivalSettings,
  describeSurvivalSettings,
} from "../survival/settings.js";
import { getSurvivalTier } from "../conway/credits.js";
import { SURVIVAL_THRESHOLDS, type HeartbeatLegacyContext, type TickContext } from "../types.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const REPO = path.join(__dirname, "..", "..");

describe("requirement 1: defaults equal today's values exactly", () => {
  it("highCents 500, normalCents 50, lowComputeCents 10, deadGraceMinutes 60 (the old constants)", () => {
    expect(DEFAULT_SURVIVAL_SETTINGS).toEqual({ highCents: 500, normalCents: 50, lowComputeCents: 10, deadGraceMinutes: 60 });
    expect(DEFAULT_SURVIVAL_SETTINGS).toMatchObject({
      highCents: SURVIVAL_THRESHOLDS.high, normalCents: SURVIVAL_THRESHOLDS.normal, lowComputeCents: SURVIVAL_THRESHOLDS.low_compute,
    });
    expect(resolveSurvivalSettings({})).toEqual(DEFAULT_SURVIVAL_SETTINGS);
    expect(resolveSurvivalSettings(null)).toEqual(DEFAULT_SURVIVAL_SETTINGS);
  });

  it("with the defaults every balance gets the same tier as before (boundaries included)", () => {
    const d = resolveSurvivalSettings({});
    const cases: [number, string][] = [
      [100_000, "high"], [501, "high"], [500, "normal"], [51, "normal"], [50, "low_compute"], [11, "low_compute"],
      [10, "critical"], [1, "critical"], [0, "critical"], [-1, "dead"], [-500, "dead"],
    ];
    for (const [cents, tier] of cases) {
      expect(getSurvivalTier(cents, d), `${cents}`).toBe(tier);
      expect(getSurvivalTier(cents), `${cents} (no thresholds)`).toBe(tier);
    }
  });

  it("the main testnet template sets no survival block, so the main agent uses exactly the defaults", () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "docker", "automaton.testnet.json"), "utf-8"));
    expect(tpl.survival).toBeUndefined();
    expect(checkSurvivalSettings(tpl)).toEqual([]);
    expect(resolveSurvivalSettings(tpl)).toEqual(DEFAULT_SURVIVAL_SETTINGS);
  });

  it("every production call of getSurvivalTier passes thresholds (no silent default)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); } else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(path.join(REPO, "src"));
    const oneArg: string[] = [];
    let calls = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf-8");
      for (const m of src.matchAll(/getSurvivalTier\(/g)) {
        if (/function getSurvivalTier\($/.test(src.slice(Math.max(0, m.index! - 9), m.index! + 16))) continue; // the definition
        let depth = 1, i = m.index! + m[0].length, topComma = false;
        for (; i < src.length && depth > 0; i++) {
          const ch = src[i];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          else if (ch === "," && depth === 1) topComma = true;
        }
        calls++;
        if (!topComma) oneArg.push(`${path.relative(REPO, f)}: ${src.slice(m.index!, i)}`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(oneArg).toEqual([]);
  });
});

describe("requirement 2: thresholds must be in order", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["high equal to normal", { highCents: 50 }],
    ["high below normal", { highCents: 40, normalCents: 50, lowComputeCents: 10 }],
    ["normal equal to lowCompute", { normalCents: 10 }],
    ["normal below lowCompute", { normalCents: 100, lowComputeCents: 200, highCents: 300 }],
    ["partial override out of order with the defaults", { normalCents: 600 }],
  ];
  for (const [name, survival] of bad) {
    it(`refuses: ${name}`, () => {
      expect(checkSurvivalSettings({ survival } as any)).toEqual([expect.stringMatching(/must be in order highCents > normalCents > lowComputeCents/)]);
      expect(resolveSurvivalSettings({ survival } as any)).toEqual(DEFAULT_SURVIVAL_SETTINGS);
    });
  }

  it("refuses negative, fractional, non-number and unknown values", () => {
    expect(checkSurvivalSettings({ survival: { lowComputeCents: -1 } } as any)[0]).toMatch(/lowComputeCents must be a whole number >= 0/);
    expect(checkSurvivalSettings({ survival: { normalCents: 49.5 } } as any)[0]).toMatch(/normalCents must be a whole number/);
    expect(checkSurvivalSettings({ survival: { highCents: "500" } } as any)[0]).toMatch(/highCents must be a whole number/);
    expect(checkSurvivalSettings({ survival: { criticalCents: 5 } } as any)[0]).toMatch(/criticalCents is not a known setting/);
    expect(checkSurvivalSettings({ survival: [] } as any)).toEqual(["survival must be an object"]);
  });

  it("accepts a valid scaled set (like the tier walk) and uses it", () => {
    const survival = { highCents: 40, normalCents: 30, lowComputeCents: 15, deadGraceMinutes: 5 };
    expect(checkSurvivalSettings({ survival })).toEqual([]);
    const s = resolveSurvivalSettings({ survival });
    expect([41, 40, 31, 30, 16, 15, 0, -1].map((c) => getSurvivalTier(c, s))).toEqual(
      ["high", "normal", "normal", "low_compute", "low_compute", "critical", "critical", "dead"],
    );
    expect(describeSurvivalSettings(s)).toBe(
      "high > $0.40, normal > $0.30, low_compute > $0.15, critical >= $0.00, dead below $0 or after 5 min at <= $0",
    );
  });
});

describe("requirement 3: deadGraceMinutes has a minimum of 1", () => {
  it("refuses 0, negative, fractional, text and more than 7 days; accepts 1 and 10080", () => {
    for (const v of [0, -5, 1.5, "5", 10_081]) {
      expect(checkSurvivalSettings({ survival: { deadGraceMinutes: v } } as any).length, String(v)).toBe(1);
    }
    expect(checkSurvivalSettings({ survival: { deadGraceMinutes: 0 } } as any)[0]).toMatch(/deadGraceMinutes must be 1\.\.10080 minutes \(got 0\)/);
    expect(checkSurvivalSettings({ survival: { deadGraceMinutes: 1 } })).toEqual([]);
    expect(checkSurvivalSettings({ survival: { deadGraceMinutes: 10_080 } })).toEqual([]);
  });

  it("the heartbeat uses the configured grace (5 min: dead after 6 min at zero, not after 4)", async () => {
    const db = createTestDb();
    try {
      const ctx = { creditBalance: 0, survivalTier: "critical", balanceStatus: "live", usdcBalance: 0 } as unknown as TickContext;
      const legacy = {
        identity: createTestIdentity(), conway: new MockConwayClient(), db,
        config: createTestConfig({ balanceSource: "own", survival: { deadGraceMinutes: 5 } }),
      } as HeartbeatLegacyContext;
      db.setKV("zero_credits_since", new Date(Date.now() - 4 * 60_000).toISOString());
      await BUILTIN_TASKS.check_credits(ctx, legacy);
      expect(db.getAgentState()).not.toBe("dead");
      db.setKV("zero_credits_since", new Date(Date.now() - 6 * 60_000).toISOString());
      await BUILTIN_TASKS.check_credits(ctx, legacy);
      expect(db.getAgentState()).toBe("dead");
    } finally {
      db.close();
    }
  });
});

describe("startup refuses invalid survival settings (preflight path)", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, openai: process.env.OPENAI_API_KEY, creator: process.env.AUTOMATON_CREATOR_ADDRESS };
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "survival-settings-home-")));
    process.env.HOME = home;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.AUTOMATON_CREATOR_ADDRESS;
    delete process.env.AUTOMATON_WALLET_PASSPHRASE;
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (_i: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const reply = (one: any) => ({ jsonrpc: "2.0", id: one.id, result: one.method === "eth_chainId" ? "0x14a34" : "0x0" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    for (const [k, v] of [["OPENAI_API_KEY", saved.openai], ["AUTOMATON_CREATOR_ADDRESS", saved.creator]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function preflight(survival?: Record<string, unknown>) {
    await (await import("../identity/wallet.js")).getWallet();
    const { createTestConfig: mk } = await import("./mocks.js");
    const { DEFAULT_MODEL_STRATEGY_CONFIG } = await import("../types.js");
    const config = mk({
      sandboxId: "", conwayApiKey: undefined as any, conway: "off", network: "testnet", balanceSource: "own",
      socialRelayUrl: "", inferenceModel: "gpt-4.1-mini", modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG }, sandbox: undefined,
      dbPath: path.join(home, ".automaton", "state.db"), heartbeatConfigPath: path.join(home, ".automaton", "heartbeat.yml"),
      skillsDir: path.join(home, ".automaton", "skills"), ...(survival ? { survival } : {}),
    } as any);
    const { runPreflight } = await import("../runtime/prepare.js");
    return runPreflight(config);
  }

  it("out-of-order thresholds: refused", async () => {
    const r = await preflight({ highCents: 50, normalCents: 50 });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/FAIL {2}startup: survival thresholds must be in order.*Refusing to start/);
  });

  it("deadGraceMinutes 0: refused", async () => {
    const r = await preflight({ deadGraceMinutes: 0 });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/survival\.deadGraceMinutes must be 1\.\.10080 minutes \(got 0\)/);
  });

  it("no survival block: passes and prints the default tiers", async () => {
    const r = await preflight();
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.lines).toContain("INFO  survival tiers: high > $5.00, normal > $0.50, low_compute > $0.10, critical >= $0.00, dead below $0 or after 60 min at <= $0");
  });
});
