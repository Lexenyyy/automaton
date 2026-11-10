/**
 * EVM Network Mode (fork change 2)
 *
 * Decides whether the agent uses Base Sepolia (testnet) or Base mainnet.
 * Testnet is the default and the fail-closed state: until activateNetwork()
 * succeeds with an explicit mainnet setting AND the owner's approval, every
 * balance read, x402 payment and ERC-8004 write uses Base Sepolia.
 *
 * Mainnet needs both:
 *   1. "network": "mainnet" in automaton.json, and
 *   2. AUTOMATON_MAINNET_APPROVED=<this agent's wallet address> in the
 *      process environment, set by the owner before start.
 * The approval is read once at startup. The agent's tools cannot change the
 * environment of the running process, and path/command rules block the files
 * that would set it on the next start (see self-mod/code.ts and
 * policy-rules/command-safety.ts).
 */

import type { Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export type NetworkMode = "testnet" | "mainnet";

export interface NetworkInfo {
  mode: NetworkMode;
  /** CAIP-2 id, e.g. "eip155:84532" */
  caip2: "eip155:84532" | "eip155:8453";
  chainId: number;
  chain: Chain;
  label: string;
}

export const NETWORKS: Readonly<Record<NetworkMode, NetworkInfo>> = Object.freeze({
  testnet: {
    mode: "testnet",
    caip2: "eip155:84532",
    chainId: baseSepolia.id,
    chain: baseSepolia,
    label: "Base Sepolia (testnet)",
  },
  mainnet: {
    mode: "mainnet",
    caip2: "eip155:8453",
    chainId: base.id,
    chain: base,
    label: "Base mainnet",
  },
});

export const DEFAULT_NETWORK_MODE: NetworkMode = "testnet";
export const MAINNET_APPROVAL_ENV = "AUTOMATON_MAINNET_APPROVED";

let active: NetworkInfo = NETWORKS[DEFAULT_NETWORK_MODE];

/**
 * Resolve the network mode from config + environment.
 * Throws when mainnet is requested without a matching owner approval,
 * or when the setting is not a known value.
 */
export function resolveNetworkMode(
  config: { network?: unknown; walletAddress?: string },
  env: Record<string, string | undefined> = process.env,
): NetworkMode {
  const requested = config.network ?? DEFAULT_NETWORK_MODE;
  if (requested === "testnet") return "testnet";
  if (requested !== "mainnet") {
    throw new Error(
      `Invalid "network" setting: ${JSON.stringify(requested)}. Use "testnet" (default) or "mainnet".`,
    );
  }

  const approval = (env[MAINNET_APPROVAL_ENV] || "").trim().toLowerCase();
  const wallet = (config.walletAddress || "").trim().toLowerCase();
  if (!wallet || !approval || approval !== wallet) {
    throw new Error(
      `Mainnet requested but not approved. The owner must set ${MAINNET_APPROVAL_ENV} ` +
        `to this agent's wallet address before start (CLAUDE.md rule 3, ROADMAP Phase 8). Refusing to start.`,
    );
  }
  return "mainnet";
}

/** Activate the network for this process. Call once at startup. */
export function activateNetwork(
  config: { network?: unknown; walletAddress?: string },
  env: Record<string, string | undefined> = process.env,
): NetworkInfo {
  active = NETWORKS[resolveNetworkMode(config, env)];
  return active;
}

export function getActiveNetwork(): NetworkInfo {
  return active;
}

/** Normalize "base" / "base-sepolia" / CAIP-2 / mode names to a mode, or null. */
export function toNetworkMode(network: string): NetworkMode | null {
  const n = network.trim().toLowerCase();
  if (n === "testnet" || n === "base-sepolia" || n === "eip155:84532") return "testnet";
  if (n === "mainnet" || n === "base" || n === "eip155:8453") return "mainnet";
  return null;
}

/**
 * Throw unless `network` is the active network. Used before signing
 * payments and before on-chain writes.
 */
export function assertNetworkAllowed(network: string): void {
  const mode = toNetworkMode(network);
  if (mode !== active.mode) {
    throw new Error(
      `Blocked: ${network} is not the active network (${active.label}). ` +
        `Payments and on-chain writes are only allowed on the active network.`,
    );
  }
}

/** Test helper: reset to the fail-closed default. */
export function resetNetworkForTests(): void {
  active = NETWORKS[DEFAULT_NETWORK_MODE];
}
