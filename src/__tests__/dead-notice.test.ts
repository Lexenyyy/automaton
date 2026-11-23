/**
 * Owner notice while dead (fork, Phase 4 step 5). Owner requirements: one WARN
 * per entry into dead (not one per check); the notice says since when, the
 * wallet to fund and how much for critical and normal, with no secrets; shown
 * in agent:status and agent:wallet while dead; reviving clears it and records
 * "revived at" in the tier history.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { evaluateSurvival, getTierChanges } from "../survival/tier-watch.js";
import { buildDeadNotice, readDeadRecord, DEAD_RECORD_KEY } from "../survival/dead-notice.js";
import { DEFAULT_SURVIVAL_SETTINGS, type SurvivalSettings } from "../survival/settings.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getActivityReport, formatActivityReport } from "../state/activity-report.js";
import { walletReport } from "../agent/wallet-report.js";
import { insertLedgerEntry } from "../state/ledger.js";
import { NETWORKS, activateNetwork, resetNetworkForTests } from "../identity/network.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase } from "../types.js";

const WALLET = "0x19557caaF9C60904dEfA248676722C0206704263";
const S: SurvivalSettings = { ...DEFAULT_SURVIVAL_SETTINGS, deadGraceMinutes: 5 };
const T0 = Date.parse("2026-11-23T20:00:00.000Z");

let db: AutomatonDatabase;
let warns: string[];
let infos: string[];
beforeEach(() => {
  db = createTestDb();
  db.setIdentity("address", WALLET);
  warns = [];
  infos = [];
});
afterEach(() => db.close());

const tick = (cents: number, min: number, status = "live", settings: SurvivalSettings = S) =>
  evaluateSurvival(db.raw, { balanceCents: cents, balanceStatus: status, balanceTier: getSurvivalTier(cents, settings) }, settings, {
    now: T0 + min * 60_000, log: (m) => infos.push(m), warn: (m) => warns.push(m), network: "Base Sepolia (testnet)",
  });

describe("entering dead: one WARN, not one per check", () => {
  it("grace path: exactly one WARN across entry and 30 more checks while dead", () => {
    tick(100, 0);
    for (let m = 1; m <= 7; m++) tick(0, m); // dead at minute 6 (5 min at $0)
    for (let m = 8; m <= 37; m++) tick(m % 3 === 0 ? -2 : 0, m, m % 4 === 0 ? "unavailable" : "live");
    expect(db.getAgentState()).toBe("dead");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^DEAD since 2026-11-23 20:06:00 UTC \(5 min at <= \$0\)\. No model calls until funded\./);
    expect(readDeadRecord(db.raw)).toEqual({ since: "2026-11-23T20:06:00.000Z", reason: "5 min at <= $0", network: "Base Sepolia (testnet)", balanceCentsAtEntry: 0 });
  });

  it("negative balance: dead at once, one WARN", () => {
    tick(100, 0);
    tick(-3, 1);
    tick(-3, 2);
    expect(warns).toHaveLength(1);
    expect(readDeadRecord(db.raw)?.reason).toBe("balance below $0");
  });

  it("dead set by the agent loop (no record yet): the next check writes it and warns once", () => {
    db.setAgentState("dead");
    tick(-1, 0);
    tick(-1, 1);
    tick(-1, 2, "unavailable");
    expect(warns).toHaveLength(1);
    expect(readDeadRecord(db.raw)?.reason).toBe("balance below $0 (seen by the agent loop)");
  });
});

describe("the network in the notice comes from the active network (config), not a fixed string", () => {
  afterEach(() => resetNetworkForTests());
  const tickNoOverride = (cents: number, min: number) =>
    evaluateSurvival(db.raw, { balanceCents: cents, balanceStatus: "live", balanceTier: getSurvivalTier(cents, S) }, S, {
      now: T0 + min * 60_000, log: () => {}, warn: (m) => warns.push(m),
    });

  it("default (config network unset or testnet): Base Sepolia (testnet)", () => {
    activateNetwork({ network: "testnet", walletAddress: WALLET }, {});
    tickNoOverride(100, 0);
    tickNoOverride(-1, 1);
    expect(readDeadRecord(db.raw)?.network).toBe("Base Sepolia (testnet)");
    expect(warns[0]).toContain(`Fund ${WALLET} on Base Sepolia (testnet)`);
  });

  it("config network mainnet with the owner's approval: Base mainnet", () => {
    activateNetwork({ network: "mainnet", walletAddress: WALLET }, { AUTOMATON_MAINNET_APPROVED: WALLET });
    tickNoOverride(100, 0);
    tickNoOverride(-1, 1);
    expect(readDeadRecord(db.raw)?.network).toBe("Base mainnet");
    expect(buildDeadNotice(db.raw, S, { balanceCents: -1 })!.text).toContain(`Fund ${WALLET} on Base mainnet:`);
  });
});

describe("the notice text", () => {
  beforeEach(() => { tick(100, 0); tick(-1, 1); });

  it("since when, wallet address and network, amounts to revive (critical) and to reach normal", () => {
    const at = (cents: number, t = S) => buildDeadNotice(db.raw, t, { balanceCents: cents })!;
    expect(at(0)).toMatchObject({ since: "2026-11-23T20:01:00.000Z", address: WALLET, network: "Base Sepolia (testnet)", toReviveCents: 1, toNormalCents: 51 });
    expect(at(-5)).toMatchObject({ toReviveCents: 6, toNormalCents: 56 });
    expect(at(-5, { ...S, normalCents: 30, highCents: 40, lowComputeCents: 15 }).toNormalCents).toBe(36);
    expect(at(0).text).toBe(
      `DEAD since 2026-11-23 20:01:00 UTC (balance below $0). No model calls until funded. Fund ${WALLET} on Base Sepolia (testnet): ` +
        "at least 0.01 USDC to revive (critical), 0.51 USDC to reach normal (balance now $0.00). Or add an owner grant: pnpm agent:ledger:grant <dollars>.",
    );
  });

  it("already above $0 (e.g. a grant just added): says the heartbeat revives it, asks for nothing to revive", () => {
    const n = buildDeadNotice(db.raw, S, { balanceCents: 20 })!;
    expect(n).toMatchObject({ toReviveCents: 0, toNormalCents: 31 });
    expect(n.text).toContain("Balance now $0.20 is above $0: the heartbeat revives the agent on its next live balance read");
    expect(n.text).toContain("0.31 USDC more to reach normal");
    expect(buildDeadNotice(db.raw, S, { balanceCents: 500 })!.text).not.toMatch(/more to reach normal|at least/);
  });

  it("contains no secrets: no key material, passphrase or API key; the only address is the public wallet", () => {
    const text = buildDeadNotice(db.raw, S, { balanceCents: 0 })!.text;
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/); // no private key / tx-hash-length hex
    expect(text).not.toMatch(/private|passphrase|secret|api[_ ]?key|sk-|mnemonic/i);
    expect(text.match(/0x[0-9a-fA-F]{40}/g)).toEqual([WALLET]);
    expect(db.getKV(DEAD_RECORD_KEY)).not.toMatch(/private|passphrase|secret|key/i);
  });
});

describe("shown while dead: agent:status and agent:wallet", () => {
  it("agent:status: banner and JSON while dead; nothing when alive", () => {
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 0, usdcBalance: 0 }));
    expect(getActivityReport(db.raw).deadNotice).toBeNull();
    tick(100, 0);
    tick(0, 1);
    tick(0, 7);
    const r = getActivityReport(db.raw, new Date(T0 + 10 * 60_000), undefined, S);
    expect(r.deadNotice).toMatchObject({ address: WALLET, toReviveCents: 1, toNormalCents: 51 });
    const text = formatActivityReport(r);
    expect(text.split("\n")[1]).toMatch(/^!!! DEAD since 2026-11-23 20:07:00 UTC .* Fund 0x19557caa/);
    expect(JSON.parse(JSON.stringify(r)).deadNotice.text).toContain("0.51 USDC to reach normal");
  });

  it("agent:status while dead but before the heartbeat wrote the record: a fallback line", () => {
    db.setAgentState("dead");
    expect(getActivityReport(db.raw).deadNotice?.text).toMatch(/^DEAD \(no notice recorded yet/);
  });

  it("agent:wallet: banner with the live balance (ledger + wallet)", () => {
    tick(100, 0);
    tick(-1, 1);
    insertLedgerEntry(db.raw, { kind: "inference_cost", amountCents: -20, livemode: true, source: "t" }); // ledger -$0.20
    const text = walletReport({
      info: { exists: true, encrypted: true, address: WALLET, chainType: "evm", createdAt: null, kdf: "scrypt" },
      network: NETWORKS.testnet, balances: { usdcUnits: 50_000n, ethWei: 0n }, // 0.05 USDC
      policy: DEFAULT_TREASURY_POLICY, creatorAddress: undefined, encryptionSetting: "required", db: db.raw, survival: S,
    });
    expect(text.split("\n")[1]).toMatch(/^!!! DEAD since .* at least 0\.16 USDC to revive \(critical\), 0\.66 USDC to reach normal \(balance now -\$0\.15\)/);
  });

  it("agent:wallet when alive: no banner", () => {
    const text = walletReport({
      info: { exists: true, encrypted: true, address: WALLET, chainType: "evm", createdAt: null, kdf: "scrypt" },
      network: NETWORKS.testnet, balances: { usdcUnits: 50_000n, ethWei: 0n },
      policy: DEFAULT_TREASURY_POLICY, creatorAddress: undefined, encryptionSetting: "required", db: db.raw,
    });
    expect(text).not.toContain("!!!");
  });
});

describe("reviving clears the notice and records 'revived at'", () => {
  it("record removed, banner gone, tier history says revived at … (dead since …)", () => {
    tick(100, 0);
    tick(-1, 1);
    const r = tick(60, 30);
    expect(r.leftDead).toBe(true);
    expect(readDeadRecord(db.raw)).toBeNull();
    expect(getActivityReport(db.raw).deadNotice).toBeNull();
    expect(getTierChanges(db.raw).at(-1)).toMatchObject({
      from: "dead", to: "normal",
      note: "revived at 2026-11-23T20:30:00.000Z (dead since 2026-11-23T20:01:00.000Z); agent woken",
    });
    expect(infos).toContain("Agent state: revived at 2026-11-23T20:30:00.000Z (dead since 2026-11-23T20:01:00.000Z); balance $0.60 is above $0 again. Resuming.");
    // dying again later writes a new record and warns again (one per entry)
    tick(-1, 40);
    expect(warns).toHaveLength(2);
    expect(readDeadRecord(db.raw)?.since).toBe("2026-11-23T20:40:00.000Z");
  });
});
