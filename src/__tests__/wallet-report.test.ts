/**
 * Owner wallet report (fork, Phase 3 step 5).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { walletReport } from "../agent/wallet-report.js";
import { NETWORKS } from "../identity/network.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { onchainTxInsert } from "../state/database.js";
import { createTestDb } from "./mocks.js";
import { DEFAULT_TREASURY_POLICY, type AutomatonDatabase } from "../types.js";

const ADDR = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x000000000000000000000000000000000000dEaD";
const POLICY = { ...DEFAULT_TREASURY_POLICY, maxSingleTransferCents: 25, maxHourlyTransferCents: 50, maxDailyTransferCents: 100, minimumReserveCents: 100, transferAllowlist: ["creator"] };
const INFO = { exists: true, encrypted: true, address: ADDR, chainType: "evm" as const, createdAt: "2026-11-16T00:00:00Z", kdf: "scrypt N=32768 r=8 p=1, aes-256-gcm" };

let db: AutomatonDatabase;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

const base = () => ({
  info: INFO, network: NETWORKS.testnet, balances: { usdcUnits: 2_500_000n, ethWei: 5n * 10n ** 15n },
  policy: POLICY, creatorAddress: CREATOR, encryptionSetting: "required", db: db.raw,
});

describe("wallet report", () => {
  it("shows balances, limits, sent amounts and no transfers yet", () => {
    const text = walletReport(base());
    expect(text).toContain(`Address:    ${ADDR}`);
    expect(text).toContain("Encrypted:  yes (scrypt");
    expect(text).toContain("Network:    Base Sepolia (testnet)");
    expect(text).toContain("USDC:       2.50 USDC");
    expect(text).toContain("ETH:        0.005000 ETH (network fees)");
    expect(text).toContain(`Payments:   per transfer $0.25, hour $0.50, day $1.00, reserve $1.00, 1/turn; recipients: creator ${CREATOR.toLowerCase()}`);
    expect(text).toContain("Sent:       0.00 USDC this UTC hour, 0.00 USDC today (UTC)");
    expect(text).toContain("Recent transfers: none");
  });

  it("lists recent send_usdc transfers and what was sent", () => {
    new SpendTracker(db.raw).recordSpend({ toolName: "send_usdc", amountCents: 10, category: "transfer" });
    onchainTxInsert(db.raw, {
      id: "t1", txHash: `0x${"cd".repeat(32)}`, chain: "eip155:84532", operation: "usdc_transfer", status: "confirmed",
      gasUsed: 50000, metadata: JSON.stringify({ to: CREATOR.toLowerCase(), amountCents: 10, reason: "test" }), createdAt: "2026-11-21T10:00:00Z",
    });
    const text = walletReport(base());
    expect(text).toContain("Sent:       0.10 USDC this UTC hour, 0.10 USDC today (UTC)");
    expect(text).toMatch(/2026-11-21T10:00:00Z {2}0\.10 USDC → 0x0{36}dead {2}confirmed {2}0x(cd){32}/);
  });

  it("an unreachable RPC shows 'unavailable', not an error", () => {
    const text = walletReport({ ...base(), balances: { usdcUnits: null, ethWei: null, error: "fetch failed" } });
    expect(text).toContain("USDC:       unavailable (fetch failed)");
    expect(text).toContain("ETH:        unavailable (fetch failed)");
  });

  it("no wallet: says so, still shows the limits", () => {
    const text = walletReport({ ...base(), info: { exists: false, encrypted: false, address: null, chainType: "evm", createdAt: null, kdf: null }, balances: null });
    expect(text).toContain("No wallet.");
    expect(text).toContain("Payments:");
  });
});
