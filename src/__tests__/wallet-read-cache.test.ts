/**
 * Wallet balance read cache (fork, Phase 4): config.walletReadCacheSeconds
 * (default 300, 0 = every time) and the refresh right after send_usdc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import {
  OwnBalanceSource,
  createBalanceSource,
  checkWalletReadCacheSeconds,
  resolveWalletReadCacheSeconds,
  walletCacheKey,
} from "../survival/balance.js";
import { sendUsdc, resetUsdcTransferStateForTests, UNITS_PER_CENT, type UsdcChain } from "../agent/usdc-transfer.js";
import { NETWORKS, resetNetworkForTests } from "../identity/network.js";
import { MockConwayClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase } from "../types.js";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x1111111111111111111111111111111111111111";
const T0 = Date.parse("2026-11-23T16:00:00.000Z");

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); resetNetworkForTests(); resetUsdcTransferStateForTests(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

describe("how often the wallet is read on chain", () => {
  async function readsInAnHour(maxAgeSeconds: number): Promise<number> {
    vi.useFakeTimers({ toFake: ["Date"] });
    let reads = 0;
    const source = new OwnBalanceSource(db.raw, ADDRESS, "evm", async () => { reads++; return 1.0; }, maxAgeSeconds * 1000);
    const sched = new DurableScheduler(db.raw, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 }, new Map(),
      { identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), db, conway: new MockConwayClient() });
    vi.spyOn(sched, "balanceSource").mockReturnValue(source);
    for (let m = 0; m < 60; m++) {
      vi.setSystemTime(T0 + m * 60_000);
      await sched.tick();
    }
    return reads;
  }

  it("default 300 s: 12 on-chain reads in an hour of 60 heartbeat ticks (was 60)", async () => {
    expect(await readsInAnHour(300)).toBe(12);
  });

  it("0 = read on chain on every tick", async () => {
    expect(await readsInAnHour(0)).toBe(60);
  });

  it("a reused read is still a live read (status live, with the time of the read)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let reads = 0;
    const s = new OwnBalanceSource(db.raw, ADDRESS, "evm", async () => { reads++; return 2.5; }, 300_000);
    await s.read();
    vi.setSystemTime(T0 + 120_000);
    const again = await s.read();
    expect(reads).toBe(1);
    expect(again).toMatchObject({ status: "live", walletUsdcCents: 250, walletReadAt: new Date(T0).toISOString() });
  });

  it("an expired cache plus a failing RPC is 'cached' (a failed read), not live", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let up = true;
    const s = new OwnBalanceSource(db.raw, ADDRESS, "evm", async () => { if (!up) throw new Error("fetch failed"); return 1; }, 300_000);
    await s.read();
    up = false;
    vi.setSystemTime(T0 + 301_000);
    expect((await s.read()).status).toBe("cached");
  });

  it("createBalanceSource applies the setting; the default is 300 s; invalid values are refused at startup", () => {
    expect(resolveWalletReadCacheSeconds({})).toBe(300);
    expect(resolveWalletReadCacheSeconds({ walletReadCacheSeconds: 0 })).toBe(0);
    expect(createBalanceSource({ config: { balanceSource: "own", walletReadCacheSeconds: 0 }, db: db.raw, conway: new MockConwayClient(), address: ADDRESS })).toBeInstanceOf(OwnBalanceSource);
    for (const bad of [-1, 3_601, 1.5, "300"]) {
      expect(checkWalletReadCacheSeconds({ walletReadCacheSeconds: bad } as any), String(bad)).toMatch(/walletReadCacheSeconds must be a whole number from 0/);
    }
    expect(checkWalletReadCacheSeconds({ walletReadCacheSeconds: 0 })).toBeNull();
    expect(checkWalletReadCacheSeconds({ walletReadCacheSeconds: 3_600 })).toBeNull();
  });
});

describe("refresh right after send_usdc", () => {
  const key = walletCacheKey("eip155:84532", ADDRESS);
  let txCounter = 0;
  function chain(opts: { receipt?: "success" | "reverted" | "timeout"; readFailsAfterSend?: boolean } = {}) {
    let cents = 500;
    let sent = false;
    const c: UsdcChain = {
      decimals: async () => 6,
      usdcBalance: async () => {
        if (sent && opts.readFailsAfterSend) throw new Error("fetch failed");
        return BigInt(cents) * UNITS_PER_CENT;
      },
      ethBalance: async () => 10n ** 16n,
      estimateTransferFeeWei: async () => 10n ** 11n,
      sendTransfer: async (_to, units) => {
        sent = true;
        if (opts.receipt !== "reverted") cents -= Number(units / UNITS_PER_CENT);
        return `0x${(++txCounter).toString(16).padStart(64, "0")}`;
      },
      waitForReceipt: async () => ({ status: opts.receipt ?? "success" }),
    };
    return c;
  }
  const send = (c: UsdcChain) => sendUsdc({
    db: db.raw, policy: { ...DEFAULT_TREASURY_POLICY, maxSingleTransferCents: 25, minimumReserveCents: 100, transferAllowlist: ["creator"] },
    creatorAddress: CREATOR, from: ADDRESS, to: CREATOR, amountCents: 20, reason: "test", network: NETWORKS.testnet, chain: c, receiptTimeoutMs: 10,
  });
  const stale = () => db.setKV(key, JSON.stringify({ usdc: 5, at: new Date().toISOString() }));

  it("confirmed: the cache holds the fresh post-payment balance (4.80 USDC), not the stale 5.00", async () => {
    stale();
    expect((await send(chain())).ok).toBe(true);
    expect(JSON.parse(db.getKV(key)!).usdc).toBe(4.8);
  });

  it("reverted: fresh read too (balance unchanged)", async () => {
    stale();
    await send(chain({ receipt: "reverted" }));
    expect(JSON.parse(db.getKV(key)!).usdc).toBe(5);
  });

  it("pending, or the fresh read fails: the cache entry is removed (next read goes on chain; reserve rule fails closed)", async () => {
    stale();
    await send(chain({ receipt: "timeout" }));
    expect(db.getKV(key)).toBeUndefined();
    resetUsdcTransferStateForTests();
    stale();
    await send(chain({ readFailsAfterSend: true }));
    expect(db.getKV(key)).toBeUndefined();
  });
});
