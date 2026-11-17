/**
 * Fork, run 5 (F6): offline handling. A model API that cannot be reached ends
 * the wake at once and the agent sleeps with growing gaps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_BACKOFF_MINUTES,
  clearOfflineStreak,
  describeNetworkError,
  getOfflineStreak,
  isNetworkError,
  offlineBackoffMs,
  recordOfflineWake,
} from "../agent/offline.js";
import { runAgentLoop } from "../agent/loop.js";
import { formatBalance } from "../survival/balance.js";
import { getActivityReport, formatActivityReport } from "../state/activity-report.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity, noToolResponse } from "./mocks.js";
import type { AgentTurn, AutomatonDatabase } from "../types.js";

const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code} api.openai.com`), { code }) });

describe("network error detection", () => {
  it("recognises connection failures, DNS errors and timeouts", () => {
    expect(isNetworkError(fetchFailed("ENOTFOUND"))).toBe(true);
    expect(isNetworkError(fetchFailed("ECONNRESET"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("Inference timeout after 120000ms"), { name: "TimeoutError" }))).toBe(true);
    expect(isNetworkError(new Error("Connection error."))).toBe(true);
    expect(isNetworkError(new Error("Request timed out."))).toBe(true);
  });

  it("does not treat provider or other errors as offline", () => {
    expect(isNetworkError(new Error("Inference error (openai): 401: invalid api key"))).toBe(false);
    expect(isNetworkError(new Error("Inference error (openai): 429: rate limit"))).toBe(false);
    expect(isNetworkError(new Error("Inference API unavailable"))).toBe(false);
    expect(isNetworkError(new Error("Daily inference budget exhausted"))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it("describes the error without its URL or keys", () => {
    expect(describeNetworkError(fetchFailed("ENOTFOUND"))).toBe("fetch failed: ENOTFOUND");
  });
});

describe("balance while the RPC is unreachable", () => {
  it("says the wallet figure is cached and since when, or unavailable", () => {
    const base = { balanceCents: 444, creditsCents: 444, walletUsdcCents: 0, ledgerCents: 444, balanceSource: "own" as const, network: "Base Sepolia (testnet)" };
    expect(formatBalance({ ...base, balanceStatus: "cached", balanceCachedAt: "2026-11-17T01:31:33.000Z" })).toBe(
      "$4.44 (wallet $0.00 USDC on Base Sepolia (testnet) + ledger $4.44) [cached: wallet RPC unreachable, last read 2026-11-17 01:31 UTC]",
    );
    expect(formatBalance({ ...base, walletUsdcCents: null, balanceStatus: "unavailable" })).toContain("[unavailable: wallet RPC unreachable]");
    expect(formatBalance({ ...base, balanceStatus: "live" })).not.toContain("[");
  });
});

describe("offline backoff", () => {
  it("30, 60, then 120 minutes; never below the sleep floor", () => {
    expect(OFFLINE_BACKOFF_MINUTES).toEqual([30, 60, 120]);
    expect([1, 2, 3, 4, 9].map((n) => offlineBackoffMs(n, 1800) / 60_000)).toEqual([30, 60, 120, 120, 120]);
    expect(offlineBackoffMs(1, 7200) / 60_000).toBe(120);
  });

  it("streak counts offline wakes in a row and clears", () => {
    const db = createTestDb();
    try {
      expect(getOfflineStreak(db.raw)).toBe(0);
      expect(recordOfflineWake(db.raw)).toBe(1);
      expect(recordOfflineWake(db.raw)).toBe(2);
      expect(getActivityReport(db.raw).offlineStreak).toBe(2);
      expect(formatActivityReport(getActivityReport(db.raw))).toContain("the last 2 wake(s) in a row could not reach the model API");
      clearOfflineStreak(db.raw);
      expect(getOfflineStreak(db.raw)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("agent loop offline", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  const run = async (inference: MockInferenceClient) => {
    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference,
      onTurnComplete: (t) => turns.push(t),
    });
    return turns;
  };

  it("one failed connection ends the wake: no retries this wake, sleep 30 min, then 60 on the next", async () => {
    let calls = 0;
    const offline = new MockInferenceClient([]);
    offline.chat = async () => {
      calls++;
      throw fetchFailed("ENOTFOUND");
    };

    expect(await run(offline)).toHaveLength(0);
    expect(calls).toBe(1);
    expect(db.getAgentState()).toBe("sleeping");
    const end = JSON.parse(db.getKV("last_wake_end")!);
    expect(end.reason).toBe("offline: model API unreachable (fetch failed: ENOTFOUND); retry in 30 min");
    const sleep1 = new Date(db.getKV("sleep_until")!).getTime() - Date.now();
    expect(sleep1).toBeGreaterThan(29 * 60_000);
    expect(sleep1).toBeLessThanOrEqual(30 * 60_000);

    await run(offline);
    expect(calls).toBe(2);
    expect(getOfflineStreak(db.raw)).toBe(2);
    const sleep2 = new Date(db.getKV("sleep_until")!).getTime() - Date.now();
    expect(sleep2).toBeGreaterThan(59 * 60_000);
  });

  it("a successful call clears the streak", async () => {
    recordOfflineWake(db.raw);
    recordOfflineWake(db.raw);
    await run(new MockInferenceClient([noToolResponse("Back online.")]));
    expect(getOfflineStreak(db.raw)).toBe(0);
  });

  it("other errors keep the old path (5 consecutive errors), not offline", async () => {
    let calls = 0;
    const broken = new MockInferenceClient([]);
    broken.chat = async () => {
      calls++;
      throw new Error("Inference error (openai): 401: invalid api key");
    };
    await run(broken);
    expect(calls).toBe(5);
    expect(JSON.parse(db.getKV("last_wake_end")!).reason).toBe("5 consecutive errors");
    expect(getOfflineStreak(db.raw)).toBe(0);
  });
});
