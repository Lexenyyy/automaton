/**
 * send_usdc (fork, Phase 3 step 3): every limit is checked in code before
 * anything is signed. A fake chain stands in for viem (no network).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendUsdc, resetUsdcTransferStateForTests, UNITS_PER_CENT, type UsdcChain } from "../agent/usdc-transfer.js";
import { NETWORKS } from "../identity/network.js";
import { createBuiltinTools } from "../agent/tools.js";
import { insertSpendRecord } from "../state/database.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase, type TreasuryPolicy } from "../types.js";

const FROM = "0x2222222222222222222222222222222222222222" as const;
const CREATOR = "0x000000000000000000000000000000000000dEaD";
const STRANGER = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}` as const;
const ETH = 10n ** 18n;

const POLICY: TreasuryPolicy = {
  ...DEFAULT_TREASURY_POLICY,
  maxSingleTransferCents: 25, maxHourlyTransferCents: 50, maxDailyTransferCents: 100,
  minimumReserveCents: 100, transferAllowlist: ["creator"],
};

function fakeChain(over: Partial<UsdcChain> & { usdcCents?: number; ethWei?: bigint } = {}) {
  const sent: { to: string; units: bigint }[] = [];
  const chain: UsdcChain = {
    decimals: async () => 6,
    usdcBalance: async () => BigInt(over.usdcCents ?? 500) * UNITS_PER_CENT,
    ethBalance: async () => over.ethWei ?? ETH / 100n,
    estimateTransferFeeWei: async () => 10n ** 12n,
    sendTransfer: async (to, units) => { sent.push({ to, units }); return HASH; },
    waitForReceipt: async () => ({ status: "success", gasUsed: 50_000n, blockNumber: 7n }),
    ...over,
  };
  return { chain, sent };
}

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); resetUsdcTransferStateForTests(); });
afterEach(() => db.close());

const send = (chain: UsdcChain, over: Record<string, unknown> = {}) =>
  sendUsdc({
    db: db.raw, policy: POLICY, creatorAddress: CREATOR, from: FROM, to: CREATOR, amountCents: 10,
    reason: "test payment", network: NETWORKS.testnet, chain, receiptTimeoutMs: 50, ...over,
  } as any);
const spendRows = () => db.raw.prepare("SELECT * FROM spend_tracking").all() as any[];
const txRows = () => db.raw.prepare("SELECT * FROM onchain_transactions").all() as any[];

describe("send_usdc refusals (nothing signed, nothing recorded)", () => {
  const cases: [string, Record<string, unknown>, Partial<UsdcChain> & { usdcCents?: number; ethWei?: bigint }, RegExp][] = [
    ["fractional amount", { amountCents: 1.5 }, {}, /whole number of cents/],
    ["zero amount", { amountCents: 0 }, {}, /whole number of cents/],
    ["string amount", { amountCents: "10" }, {}, /whole number of cents/],
    ["above the per-transfer limit", { amountCents: 26 }, {}, /above the per-transfer limit of 0.25 USDC/],
    ["no reason", { reason: " " }, {}, /reason is required/],
    ["reason too long", { reason: "x".repeat(201) }, {}, /at most 200/],
    ["invalid address", { to: "0x123" }, {}, /not a valid address/],
    ["recipient not on the list", { to: STRANGER }, {}, /not on the owner's recipient list/],
    ["own wallet", { to: FROM, policy: { ...POLICY, transferAllowlist: ["creator", FROM] } }, {}, /own wallet/],
    ["payments off (empty list)", { policy: { ...POLICY, transferAllowlist: [] } }, {}, /not allowed payments to anyone/],
    ["reserve would be broken", { amountCents: 25 }, { usdcCents: 124 }, /less than the 1.00 USDC reserve/],
    ["no ETH for gas", {}, { ethWei: 10n ** 12n }, /not enough ETH/],
    ["token decimals are not 6", {}, { decimals: async () => 18 }, /reports 18 decimals/],
    ["RPC unreachable", {}, { usdcBalance: async () => { throw new Error("fetch failed"); } }, /could not read balances/],
  ];
  for (const [name, args, chainOver, msg] of cases) {
    it(name, async () => {
      const { chain, sent } = fakeChain(chainOver);
      const r = await send(chain, args);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Blocked: /);
      expect(r.message).toMatch(msg);
      expect(sent).toEqual([]);
      expect(spendRows()).toEqual([]);
      expect(txRows()).toEqual([]);
    });
  }

  it("hourly limit counts earlier payments this hour", async () => {
    const now = new Date().toISOString();
    insertSpendRecord(db.raw, { id: "x", toolName: "send_usdc", amountCents: 45, recipient: null, domain: null, category: "transfer", windowHour: now.slice(0, 13), windowDay: now.slice(0, 10) });
    const { chain, sent } = fakeChain();
    const r = await send(chain, { amountCents: 10 });
    expect(r.message).toMatch(/hourly payment limit: 0.45 USDC already sent, limit 0.50 USDC/);
    expect(sent).toEqual([]);
  });

  it("the daily limit holds across hours", async () => {
    const now = new Date().toISOString();
    insertSpendRecord(db.raw, { id: "y", toolName: "send_usdc", amountCents: 95, recipient: null, domain: null, category: "transfer", windowHour: "2000-01-01T00", windowDay: now.slice(0, 10) });
    const { chain } = fakeChain();
    expect((await send(chain, { amountCents: 10 })).message).toMatch(/daily payment limit: 0.95 USDC already sent, limit 1.00 USDC/);
  });
});

describe("send_usdc success and failure paths", () => {
  it("sends exactly amount × 10^4 base units to the creator and records it", async () => {
    const { chain, sent } = fakeChain();
    const r = await send(chain, { amountCents: 25, to: CREATOR.toLowerCase() });
    expect(r).toMatchObject({ ok: true, status: "confirmed", txHash: HASH });
    expect(r.message).toMatch(/Sent 0.25 USDC to 0x000000000000000000000000000000000000dead on Base Sepolia/);
    expect(sent).toEqual([{ to: CREATOR.toLowerCase(), units: 250_000n }]);
    expect(spendRows()).toHaveLength(1);
    expect(spendRows()[0]).toMatchObject({ tool_name: "send_usdc", amount_cents: 25, category: "transfer" });
    expect(txRows()[0]).toMatchObject({ tx_hash: HASH, chain: "eip155:84532", operation: "usdc_transfer", status: "confirmed", gas_used: 50000 });
    expect(JSON.parse(txRows()[0].metadata)).toMatchObject({ reason: "test payment", amountCents: 25 });
  });

  it("exactly amount + reserve in the wallet is enough", async () => {
    const { chain, sent } = fakeChain({ usdcCents: 125 });
    expect((await send(chain, { amountCents: 25 })).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("a broadcast error releases the reserved spend and records no transaction", async () => {
    const { chain } = fakeChain({ sendTransfer: async () => { throw new Error("nonce too low"); } });
    const r = await send(chain);
    expect(r.message).toMatch(/was not sent \(nonce too low\)/);
    expect(spendRows()).toEqual([]);
    expect(txRows()).toEqual([]);
  });

  it("a reverted transaction is marked failed and releases the spend", async () => {
    const { chain } = fakeChain({ waitForReceipt: async () => ({ status: "reverted", gasUsed: 30_000n }) });
    const r = await send(chain);
    expect(r).toMatchObject({ ok: false, code: "REVERTED" });
    expect(spendRows()).toEqual([]);
    expect(txRows()[0].status).toBe("failed");
  });

  it("an unconfirmed transaction stays pending and keeps counting against the limits", async () => {
    const { chain } = fakeChain({ waitForReceipt: async () => ({ status: "timeout" }) });
    const r = await send(chain);
    expect(r).toMatchObject({ ok: true, status: "pending" });
    expect(r.message).toMatch(/Do not send it again/);
    expect(spendRows()).toHaveLength(1);
    expect(txRows()[0].status).toBe("pending");
  });

  it("one transfer at a time", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const { chain, sent } = fakeChain({ waitForReceipt: async () => { await gate; return { status: "success" }; } });
    const first = send(chain);
    await new Promise((r) => setTimeout(r, 10));
    const second = await send(chain);
    expect(second.message).toMatch(/another payment is still being sent/);
    finish();
    expect((await first).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("send_usdc tool registration", () => {
  it("exists as a dangerous financial tool with required reason", () => {
    const tool = createBuiltinTools("").find((t) => t.name === "send_usdc");
    expect(tool).toMatchObject({ category: "financial", riskLevel: "dangerous" });
    expect(tool?.parameters.required).toEqual(["to_address", "amount_cents", "reason"]);
  });

  it("is not in the testnet template's toolAllowlist yet (the agent cannot call it)", () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docker", "automaton.testnet.json"), "utf-8"));
    expect(tpl.toolAllowlist).not.toContain("send_usdc");
  });
});
