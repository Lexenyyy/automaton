/**
 * Creator address from AUTOMATON_CREATOR_ADDRESS or the config (fork, Phase 1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATOR_ADDRESS_ENV,
  resolveCreatorAddress,
  validateCreatorAddress,
} from "../identity/creator.js";

describe("creator address", () => {
  const saved = process.env[CREATOR_ADDRESS_ENV];
  beforeEach(() => {
    delete process.env[CREATOR_ADDRESS_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[CREATOR_ADDRESS_ENV];
    else process.env[CREATOR_ADDRESS_ENV] = saved;
  });

  it("env wins over the config value; blank env falls back to the config", () => {
    expect(resolveCreatorAddress("0xabc")).toBe("0xabc");
    process.env[CREATOR_ADDRESS_ENV] = "  0x000000000000000000000000000000000000dEaD  ";
    expect(resolveCreatorAddress("0xabc")).toBe("0x000000000000000000000000000000000000dEaD");
    process.env[CREATOR_ADDRESS_ENV] = "   ";
    expect(resolveCreatorAddress(" 0xabc ")).toBe("0xabc");
    expect(resolveCreatorAddress(undefined)).toBe("");
  });

  it("accepts a valid EVM address (checksummed or all lowercase)", () => {
    expect(validateCreatorAddress("0x000000000000000000000000000000000000dEaD", "evm")).toBeNull();
    expect(validateCreatorAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "evm")).toBeNull();
  });

  it("refuses empty, zero, malformed and bad-checksum EVM addresses", () => {
    expect(validateCreatorAddress("", "evm")).toMatch(/No creator address/);
    expect(validateCreatorAddress("0x0000000000000000000000000000000000000000", "evm")).toMatch(/zero address/);
    expect(validateCreatorAddress("0x1234", "evm")).toMatch(/not a valid EVM address/);
    expect(validateCreatorAddress("0x000000000000000000000000000000000000DeAd", "evm")).toMatch(/checksum/);
    for (const msg of [validateCreatorAddress("", "evm"), validateCreatorAddress("0x1234", "evm")]) {
      expect(msg).toContain(CREATOR_ADDRESS_ENV);
    }
  });

  it("checks Solana addresses by format", () => {
    expect(validateCreatorAddress("11111111111111111111111111111111", "solana")).toBeNull();
    expect(validateCreatorAddress("0x000000000000000000000000000000000000dEaD", "solana")).toMatch(/Solana/);
  });
});
