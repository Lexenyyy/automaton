/**
 * Payment limits as owner settings (fork, Phase 3 step 2).
 *
 * The limits live in config.treasuryPolicy (read-only to the agent):
 *   - maxSingleTransferCents / maxHourlyTransferCents / maxDailyTransferCents:
 *     per transfer, per UTC clock hour, per UTC day (spend_tracking windows;
 *     cents of USDC: 100 = 1 USDC)
 *   - minimumReserveCents: wallet USDC that must stay after any transfer
 *   - maxTransfersPerTurn
 *   - transferAllowlist: the only recipients of on-chain payments. Empty (the
 *     default) = no payments to anyone. "creator" stands for the owner's
 *     creator address, so the committed template holds no address.
 *
 * This module validates the settings at startup and resolves the recipient
 * list. The checks before a payment are in the send_usdc tool and the
 * financial policy rules (Phase 3 steps 3 and 4).
 */

import { isAddress } from "viem";
import { DEFAULT_TREASURY_POLICY, type TreasuryPolicy } from "../types.js";

export const CREATOR_RECIPIENT = "creator";
export const MAX_ALLOWLIST_ENTRIES = 20;
const ZERO_EVM_ADDRESS = /^0x0{40}$/i;

/** Transfer limits that must be whole, non-negative amounts (loadConfig keeps them as written). */
export const CENT_LIMITS = [
  "maxSingleTransferCents",
  "maxHourlyTransferCents",
  "maxDailyTransferCents",
  "minimumReserveCents",
  "maxTransfersPerTurn",
  "requireConfirmationAboveCents",
] as const;

/** Problems with the payment settings (empty = valid). The startup refuses to start on any. */
export function checkPaymentLimits(policy: TreasuryPolicy): string[] {
  const problems: string[] = [];
  for (const key of CENT_LIMITS) {
    const v = policy[key];
    if (!Number.isInteger(v) || v < 0) problems.push(`treasuryPolicy.${key} must be a whole number >= 0 (got ${JSON.stringify(v)})`);
  }
  if (problems.length) return problems;
  if (policy.maxSingleTransferCents > policy.maxHourlyTransferCents) {
    problems.push("treasuryPolicy.maxSingleTransferCents must not exceed maxHourlyTransferCents");
  }
  if (policy.maxHourlyTransferCents > policy.maxDailyTransferCents) {
    problems.push("treasuryPolicy.maxHourlyTransferCents must not exceed maxDailyTransferCents");
  }
  const list = policy.transferAllowlist;
  if (!Array.isArray(list)) {
    problems.push("treasuryPolicy.transferAllowlist must be a list of addresses or \"creator\"");
    return problems;
  }
  if (list.length > MAX_ALLOWLIST_ENTRIES) {
    problems.push(`treasuryPolicy.transferAllowlist has more than ${MAX_ALLOWLIST_ENTRIES} entries`);
  }
  for (const entry of list) {
    if (entry === CREATOR_RECIPIENT) continue;
    if (typeof entry !== "string" || !isAddress(entry, { strict: true }) || ZERO_EVM_ADDRESS.test(entry)) {
      problems.push(`treasuryPolicy.transferAllowlist: ${JSON.stringify(entry)} is not a valid non-zero EVM address (or "creator")`);
    }
  }
  return problems;
}

/**
 * The allowed recipients, lowercased, with "creator" replaced by the creator
 * address (left out when that is not a valid EVM address).
 */
export function resolveTransferAllowlist(policy: TreasuryPolicy, creatorAddress: string | undefined): string[] {
  const out = new Set<string>();
  for (const entry of Array.isArray(policy.transferAllowlist) ? policy.transferAllowlist : []) {
    const addr = entry === CREATOR_RECIPIENT ? creatorAddress ?? "" : entry;
    if (typeof addr === "string" && isAddress(addr, { strict: false }) && !ZERO_EVM_ADDRESS.test(addr)) out.add(addr.toLowerCase());
  }
  return [...out];
}

/** Limits that are looser than the code defaults (preflight warns, does not refuse). */
export function looserThanDefaults(policy: TreasuryPolicy): string[] {
  const looser: string[] = [];
  for (const key of ["maxSingleTransferCents", "maxHourlyTransferCents", "maxDailyTransferCents", "maxTransfersPerTurn"] as const) {
    if (policy[key] > DEFAULT_TREASURY_POLICY[key]) looser.push(`${key} ${policy[key]} > default ${DEFAULT_TREASURY_POLICY[key]}`);
  }
  if (policy.minimumReserveCents < DEFAULT_TREASURY_POLICY.minimumReserveCents) {
    looser.push(`minimumReserveCents ${policy.minimumReserveCents} < default ${DEFAULT_TREASURY_POLICY.minimumReserveCents}`);
  }
  return looser;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** One line for preflight and `agent:wallet`. */
export function describePaymentLimits(policy: TreasuryPolicy, creatorAddress: string | undefined): string {
  const recipients = resolveTransferAllowlist(policy, creatorAddress);
  const who = recipients.length === 0
    ? "none (payments off)"
    : recipients.map((r) => (creatorAddress && r === creatorAddress.toLowerCase() ? `creator ${r}` : r)).join(", ");
  return `per transfer ${usd(policy.maxSingleTransferCents)}, hour ${usd(policy.maxHourlyTransferCents)}, ` +
    `day ${usd(policy.maxDailyTransferCents)}, reserve ${usd(policy.minimumReserveCents)}, ` +
    `${policy.maxTransfersPerTurn}/turn; recipients: ${who}`;
}
