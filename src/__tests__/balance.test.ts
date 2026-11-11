/**
 * Fork change 3: own balance source (wallet USDC on the active network + ledger)
 * and survival tiers built on it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No real RPC calls: the default wallet reader goes through this mock.
const walletMock = vi.hoisted(() => ({
  result: { balance: 0, network: "eip155:84532", ok: true } as { balance: number; network: string; ok: boolean; error?: string },
}));
vi.mock("../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conway/x402.js")>();
  return {
    ...actual,
    getUsdcBalanceDetailed: vi.fn(async () => walletMock.result),
    getUsdcBalance: vi.fn(async () => walletMock.result.balance),
  };
});

import {
  OwnBalanceSource,
  ConwayBalanceSource,
  createBalanceSource,
  toFinancialState,
  formatBalance,
  usdcToCents,
} from "../survival/balance.js";
import { insertLedgerEntry } from "../state/ledger.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { activateNetwork, resetNetworkForTests, MAINNET_APPROVAL_ENV } from "../identity/network.js";
import { buildTickContext } from "../heartbeat/tick-context.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { buildPlannerContext } from "../orchestration/planner-context.js";
import { buildWakeupPrompt } from "../agent/system-prompt.js";
import { createBuiltinTools } from "../agent/tools.js";
import { runAgentLoop } from "../agent/loop.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestDb,
  createTestConfig,
  createTestIdentity,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
let db: AutomatonDatabase;

beforeEach(() => {
  db = createTestDb();
  walletMock.result = { balance: 0, network: "eip155:84532", ok: true };
});

afterEach(() => {
  resetNetworkForTests();
  db.close();
});

const grant = (cents: number, livemode = true) =>
  insertLedgerEntry(db.raw, { kind: "owner_grant", amountCents: cents, livemode, source: "owner_cli" });

const fixedWallet = (usdc: number) => async () => usdc;
const failingWallet = async () => {
  throw new Error("RPC down");
};

describe("usdcToCents", () => {
  it("rounds down and never overstates", () => {
    expect(usdcToCents(0.29)).toBe(29);
    expect(usdcToCents(1.234567)).toBe(123);
    expect(usdcToCents(0.009999)).toBe(0);
    expect(usdcToCents(5)).toBe(500);
  });
});

describe("OwnBalanceSource", () => {
  it("adds wallet USDC and the ledger", async () => {
    grant(300);
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(2.5)).read();
    expect(s).toMatchObject({ kind: "own", status: "live", walletUsdcCents: 250, ledgerCents: 300, balanceCents: 550 });
    expect(s.network).toContain("Sepolia");
  });

  it("a failed wallet read with no cache is 'unavailable', not 0", async () => {
    grant(100);
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm", failingWallet).read();
    expect(s.status).toBe("unavailable");
    expect(s.walletUsdcCents).toBeNull();
  });

  it("a failed wallet read falls back to the last good value for the same network", async () => {
    await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(3)).read();
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm", failingWallet).read();
    expect(s.status).toBe("cached");
    expect(s.walletUsdcCents).toBe(300);
  });

  it("the default reader treats an !ok RPC result as a failure, not as 0", async () => {
    walletMock.result = { balance: 0, network: "eip155:84532", ok: false, error: "timeout" };
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm").read();
    expect(s.status).toBe("unavailable");
  });

  it("testnet counts test money; mainnet counts only real money", async () => {
    grant(200, true);
    insertLedgerEntry(db.raw, { kind: "stripe_revenue", amountCents: 1000, livemode: false, source: "stripe_webhook", externalId: "evt_t" });
    const testnet = await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(0)).read();
    expect(testnet.ledgerCents).toBe(1200);

    activateNetwork({ network: "mainnet", walletAddress: ADDRESS }, { [MAINNET_APPROVAL_ENV]: ADDRESS });
    const mainnet = await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(0)).read();
    expect(mainnet.ledgerCents).toBe(200);
  });

  it("wallet cache is per address (another wallet's value is never reused)", async () => {
    await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(9)).read();
    const other = await new OwnBalanceSource(db.raw, "0x3333333333333333333333333333333333333333", "evm", failingWallet).read();
    expect(other.status).toBe("unavailable");
  });

  it("wallet cache is per network (a testnet value is never used on mainnet)", async () => {
    await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(9)).read();
    activateNetwork({ network: "mainnet", walletAddress: ADDRESS }, { [MAINNET_APPROVAL_ENV]: ADDRESS });
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm", failingWallet).read();
    expect(s.status).toBe("unavailable");
  });
});

describe("survival tiers on the own balance", () => {
  it("a $6 grant drained by inference walks high → normal → low_compute → critical → dead", async () => {
    grant(600);
    const tracker = new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG);
    const source = new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(0));
    const spend = (cents: number) =>
      tracker.recordCost({
        sessionId: "s", turnId: null, model: "gpt-4.1-mini", provider: "openai", inputTokens: 1, outputTokens: 1,
        costCents: cents, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
      });
    const tier = async () => getSurvivalTier((await source.read()).balanceCents);

    expect(await tier()).toBe("high"); // 600
    spend(150);
    expect(await tier()).toBe("normal"); // 450
    spend(420);
    expect(await tier()).toBe("low_compute"); // 30
    spend(25);
    expect(await tier()).toBe("critical"); // 5
    spend(10);
    expect(await tier()).toBe("dead"); // -5: dead right away
  });

  it("testnet USDC in the wallet counts toward survival", async () => {
    const s = await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(1)).read();
    expect(getSurvivalTier(s.balanceCents)).toBe("normal"); // 100c
  });
});

describe("createBalanceSource", () => {
  it("defaults to own; 'conway' keeps upstream credits", () => {
    const conway = new MockConwayClient();
    expect(createBalanceSource({ config: {}, db: db.raw, conway, address: ADDRESS }).kind).toBe("own");
    expect(createBalanceSource({ config: { balanceSource: "conway" }, db: db.raw, conway, address: ADDRESS }).kind).toBe("conway");
  });

  it("Conway source reports 'unavailable' (not -1) when the API fails with no cache", async () => {
    const conway = new MockConwayClient();
    conway.getCreditsBalance = async () => {
      throw new Error("down");
    };
    const s = await new ConwayBalanceSource(db.raw, conway, ADDRESS).read();
    expect(s.status).toBe("unavailable");
  });
});

describe("heartbeat on the own balance", () => {
  const hbConfig = { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 } as any;

  it("tick uses the given source and keeps the last tier when the balance is unavailable", async () => {
    grant(600);
    const conway = new MockConwayClient();
    const live = await buildTickContext(db.raw, conway, hbConfig, ADDRESS, "evm", new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(0)));
    expect(live.survivalTier).toBe("high");
    expect(live.creditBalance).toBe(600);

    const down = await buildTickContext(db.raw, conway, hbConfig, ADDRESS, "evm", new OwnBalanceSource(db.raw, "0x2222222222222222222222222222222222222222", "evm", failingWallet));
    expect(down.balanceStatus).toBe("unavailable");
    expect(down.survivalTier).toBe("high");
  });

  it("check_credits does not start the dead timer on an unavailable balance", async () => {
    const ctx = { creditBalance: 0, survivalTier: "critical", balanceStatus: "unavailable" } as any;
    const taskCtx = { db, config: createTestConfig({ balanceSource: "own" }) } as any;
    await BUILTIN_TASKS.check_credits(ctx, taskCtx);
    expect(db.getKV("zero_credits_since")).toBeUndefined();
  });
});

describe("one tier calculation everywhere", () => {
  it("planner context uses getSurvivalTier (negative = dead, not clamped)", async () => {
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: -5, usdcBalance: 0 }));
    expect((await buildPlannerContext({ db: db.raw })).survivalTier).toBe("dead");
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 600, usdcBalance: 0 }));
    expect((await buildPlannerContext({ db: db.raw })).survivalTier).toBe("high");
  });

  it("wake-up prompt shows wallet + ledger", async () => {
    grant(300);
    const s = toFinancialState(await new OwnBalanceSource(db.raw, ADDRESS, "evm", fixedWallet(1)).read());
    const prompt = buildWakeupPrompt({ identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), financial: s, db });
    expect(prompt).toContain(formatBalance(s));
    expect(prompt).toContain("ledger $3.00");
  });
});

describe("check_balance tool", () => {
  it("is read-only and reports balance, tier and lifetime spend", async () => {
    grant(250);
    walletMock.result = { balance: 1, network: "eip155:84532", ok: true };
    const tool = createBuiltinTools("sandbox").find((t) => t.name === "check_balance")!;
    expect(tool.riskLevel).toBe("safe");
    const out = await tool.execute({}, {
      config: createTestConfig({ balanceSource: "own" }),
      db,
      conway: new MockConwayClient(),
      identity: createTestIdentity(),
    } as any);
    expect(out).toContain("$3.50");
    expect(out).toContain("tier: normal");
    expect(out).toContain("lifetime inference spend: $0.00");
  });
});

describe("agent loop on the own balance", () => {
  it("an unavailable balance means low-compute, not dead", async () => {
    walletMock.result = { balance: 0, network: "eip155:84532", ok: false, error: "RPC down" };
    const inference = new MockInferenceClient([noToolResponse("ok")]);
    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ balanceSource: "own" }),
      db,
      conway: new MockConwayClient(),
      inference,
    });
    expect(inference.lowComputeMode).toBe(true);
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("does not try to buy Conway credits with the own balance", async () => {
    walletMock.result = { balance: 10, network: "eip155:84532", ok: true };
    const conway = new MockConwayClient();
    conway.creditsCents = 0;
    const inference = new MockInferenceClient([noToolResponse("ok")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), db, conway, inference });
    expect(db.getKV("last_inline_topup_attempt")).toBeUndefined();
  });
});
