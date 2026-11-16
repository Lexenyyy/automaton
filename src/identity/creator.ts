/**
 * Creator address (fork, Phase 1).
 *
 * The owner sets it with the AUTOMATON_CREATOR_ADDRESS environment variable
 * (preferred: keeps the address out of the committed config template) or the
 * "creatorAddress" config field. Startup refuses a missing, zero or invalid one.
 */

import { isAddress } from "viem";
import type { ChainType } from "./chain.js";

export const CREATOR_ADDRESS_ENV = "AUTOMATON_CREATOR_ADDRESS";

const ZERO_EVM_ADDRESS = /^0x0{40}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The env value (trimmed) wins over the config value. */
export function resolveCreatorAddress(configValue: string | undefined): string {
  const fromEnv = process.env[CREATOR_ADDRESS_ENV]?.trim();
  return fromEnv || (configValue ?? "").trim();
}

/** Returns an error message, or null when the address is usable. */
export function validateCreatorAddress(address: string, chainType: ChainType): string | null {
  const hint = `Set ${CREATOR_ADDRESS_ENV} (or "creatorAddress" in the config) to your own wallet address.`;
  if (!address) {
    return `No creator address. ${hint}`;
  }
  if (chainType === "solana") {
    return SOLANA_ADDRESS.test(address) ? null : `Creator address is not a valid Solana address. ${hint}`;
  }
  if (ZERO_EVM_ADDRESS.test(address)) {
    return `Creator address is the zero address. ${hint}`;
  }
  // Strict: a mixed-case address must have a correct EIP-55 checksum.
  if (!isAddress(address, { strict: true })) {
    return `Creator address is not a valid EVM address (or its checksum is wrong). ${hint}`;
  }
  return null;
}
