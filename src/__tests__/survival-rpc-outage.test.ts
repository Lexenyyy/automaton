/**
 * A failed or unreadable balance read while alive must never count as $0, start
 * the dead grace timer, or record a tier change (owner requirement before
 * Phase 4 step 4). Real scheduler + real OwnBalanceSource; the wallet RPC
 * fails for 90 minutes of heartbeat ticks. The balance is all wallet (ledger
 * $0), so a failed read counted as $0 would make the agent dead after the
 * 60-minute default grace.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import { OwnBalanceSource } from "../survival/balance.js";
import { getTierChanges, TIER_KEY } from "../survival/tier-watch.js";
import { insertLedgerEntry } from "../state/ledger.js";
import { runAgentLoop } from "../agent/loop.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity, noToolResponse } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const T0 = Date.parse("2026-11-23T14:00:00.000Z");

let db: AutomatonDatabase;
let rpcUp: boolean;
const reader = async () => {
  if (!rpcUp) throw new Error("fetch failed");
  return 1.0; // 1.00 USDC = 100 cents: tier normal
};

function scheduler() {
  const s = new DurableScheduler(db.raw, { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 }, new Map(),
    { identity: createTestIdentity(), config: createTestConfig({ balanceSource: "own" }), db, conway: new MockConwayClient() });
  vi.spyOn(s, "balanceSource").mockReturnValue(new OwnBalanceSource(db.raw, ADDRESS, "evm", reader));
  return s;
}

async function ninetyMinutesOfTicks(s: DurableScheduler, startMin: number): Promise<void> {
  for (let m = startMin; m < startMin + 90; m++) {
    vi.setSystemTime(T0 + m * 60_000);
    await s.tick();
    expect(db.getAgentState(), `minute ${m}`).not.toBe("dead");
    expect(db.getKV("zero_credits_since"), `minute ${m}`).toBeUndefined();
  }
}

beforeEach(() => {
  db = createTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

describe("wallet RPC down for 90 minutes at a normal balance", () => {
  it("after a good read (cached value): no dead, no timer, no tier change, tier stays normal", async () => {
    const s = scheduler();
    rpcUp = true;
    await s.tick(); // live read: normal
    expect(db.getKV(TIER_KEY)).toBe("normal");
    rpcUp = false;
    await ninetyMinutesOfTicks(s, 1);
    expect(getTierChanges(db.raw)).toEqual([]);
    expect(db.getKV(TIER_KEY)).toBe("normal");
  });

  it("a ledger change during the outage (stale wallet + new ledger crosses a boundary) records nothing", async () => {
    const s = scheduler();
    rpcUp = true;
    await s.tick(); // live: 100 cents, normal
    rpcUp = false;
    // Inference spend while the wallet cannot be read: cached total 100 - 60 = 40 cents ("low_compute").
    insertLedgerEntry(db.raw, { kind: "inference_cost", amountCents: -60, livemode: true, source: "test" });
    await ninetyMinutesOfTicks(s, 1);
    expect(getTierChanges(db.raw)).toEqual([]); // before the fix: normal → low_compute from a failed read
    expect(db.getKV(TIER_KEY)).toBe("normal");
    rpcUp = true; // the next live read decides
    vi.setSystemTime(T0 + 91 * 60_000);
    await s.tick();
    expect(getTierChanges(db.raw).map((c) => [c.from, c.to, c.balanceCents])).toEqual([["normal", "low_compute", 40]]);
  });

  it("cold start with the RPC already down (no value at all, ledger $0): never counted as $0", async () => {
    const s = scheduler();
    rpcUp = false;
    await ninetyMinutesOfTicks(s, 0);
    expect(getTierChanges(db.raw)).toEqual([]);
    expect(db.getKV(TIER_KEY)).toBeUndefined();
  });

  it("when the RPC comes back, the live read resumes normally (no spurious change)", async () => {
    const s = scheduler();
    rpcUp = true;
    await s.tick();
    rpcUp = false;
    await ninetyMinutesOfTicks(s, 1);
    rpcUp = true;
    vi.setSystemTime(T0 + 91 * 60_000);
    await s.tick();
    expect(getTierChanges(db.raw)).toEqual([]);
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("the agent loop with an unreadable balance does not end the wake as dead", async () => {
    rpcUp = false;
    const conway = new MockConwayClient();
    conway.getCreditsBalance = async () => { throw new Error("down"); }; // test config uses the Conway source
    const inference = new MockInferenceClient([noToolResponse("ok")]);
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db, conway, inference });
    expect(db.getAgentState()).not.toBe("dead");
  });
});
