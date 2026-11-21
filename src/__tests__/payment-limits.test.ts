/**
 * Payment limits as owner settings (fork, Phase 3 step 2).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  checkPaymentLimits,
  resolveTransferAllowlist,
  looserThanDefaults,
  describePaymentLimits,
} from "../agent/payment-limits.js";
import { DEFAULT_TREASURY_POLICY, type TreasuryPolicy } from "../types.js";

const CREATOR = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x1111111111111111111111111111111111111111";
const p = (over: Partial<TreasuryPolicy> = {}): TreasuryPolicy => ({ ...DEFAULT_TREASURY_POLICY, ...over });

describe("payment limits", () => {
  it("defaults are valid and allow no recipients (payments off)", () => {
    expect(checkPaymentLimits(DEFAULT_TREASURY_POLICY)).toEqual([]);
    expect(DEFAULT_TREASURY_POLICY.transferAllowlist).toEqual([]);
    expect(resolveTransferAllowlist(DEFAULT_TREASURY_POLICY, CREATOR)).toEqual([]);
    expect(describePaymentLimits(DEFAULT_TREASURY_POLICY, CREATOR)).toContain("recipients: none (payments off)");
  });

  it("refuses negative, fractional or non-number limits", () => {
    expect(checkPaymentLimits(p({ maxSingleTransferCents: -1 }))[0]).toMatch(/maxSingleTransferCents must be a whole number/);
    expect(checkPaymentLimits(p({ minimumReserveCents: 1.5 }))[0]).toMatch(/minimumReserveCents/);
    expect(checkPaymentLimits(p({ maxDailyTransferCents: "100" as unknown as number }))[0]).toMatch(/maxDailyTransferCents/);
  });

  it("refuses per-transfer > hour > day inconsistencies", () => {
    expect(checkPaymentLimits(p({ maxSingleTransferCents: 60, maxHourlyTransferCents: 50 }))).toEqual([
      "treasuryPolicy.maxSingleTransferCents must not exceed maxHourlyTransferCents",
    ]);
    expect(checkPaymentLimits(p({ maxHourlyTransferCents: 3000 }))).toContain(
      "treasuryPolicy.maxHourlyTransferCents must not exceed maxDailyTransferCents",
    );
  });

  it("checks recipients: valid checksummed addresses or \"creator\"; no zero address", () => {
    expect(checkPaymentLimits(p({ transferAllowlist: ["creator", OTHER] }))).toEqual([]);
    expect(checkPaymentLimits(p({ transferAllowlist: ["0x0000000000000000000000000000000000000000"] }))[0]).toMatch(/not a valid non-zero/);
    expect(checkPaymentLimits(p({ transferAllowlist: ["0x000000000000000000000000000000000000DEAD"] }))[0]).toMatch(/not a valid/); // bad checksum
    expect(checkPaymentLimits(p({ transferAllowlist: ["me"] }))[0]).toMatch(/not a valid/);
    expect(checkPaymentLimits(p({ transferAllowlist: "creator" as unknown as string[] }))[0]).toMatch(/must be a list/);
    expect(checkPaymentLimits(p({ transferAllowlist: Array(21).fill("creator") }))[0]).toMatch(/more than 20/);
  });

  it("resolves \"creator\" to the creator address, lowercased, without duplicates", () => {
    expect(resolveTransferAllowlist(p({ transferAllowlist: ["creator", CREATOR, OTHER] }), CREATOR)).toEqual([CREATOR.toLowerCase(), OTHER]);
    expect(resolveTransferAllowlist(p({ transferAllowlist: ["creator"] }), "")).toEqual([]);
  });

  it("reports limits looser than the code defaults", () => {
    expect(looserThanDefaults(DEFAULT_TREASURY_POLICY)).toEqual([]);
    expect(looserThanDefaults(p({ maxDailyTransferCents: 5000, minimumReserveCents: 0 }))).toEqual([
      "maxDailyTransferCents 5000 > default 2000",
      "minimumReserveCents 0 < default 1000",
    ]);
  });

  it("the testnet template is valid, tighter than the defaults except the reserve, and pays only the creator", () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docker", "automaton.testnet.json"), "utf-8"));
    const policy = p(tpl.treasuryPolicy);
    expect(checkPaymentLimits(policy)).toEqual([]);
    expect(policy).toMatchObject({ maxSingleTransferCents: 25, maxHourlyTransferCents: 50, maxDailyTransferCents: 100, minimumReserveCents: 100, maxTransfersPerTurn: 1 });
    expect(looserThanDefaults(policy)).toEqual(["minimumReserveCents 100 < default 1000"]);
    expect(resolveTransferAllowlist(policy, CREATOR)).toEqual([CREATOR.toLowerCase()]);
  });
});
