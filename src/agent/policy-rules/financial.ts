/**
 * Financial Policy Rules
 *
 * Enforces spend limits, domain allowlists, and transfer caps
 * to prevent iterative credit drain and unauthorized payments.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  TreasuryPolicy,
} from "../../types.js";
import { isAddress } from "viem";
import { resolveTransferAllowlist } from "../payment-limits.js";
import { getActiveNetwork } from "../../identity/network.js";

/**
 * Fork (Phase 3 step 4, owner-approved under rule 4, tightening only): the
 * tools that move funds and share the transfer limits. The loop and the
 * general harness count both toward maxTransfersPerTurn.
 */
export const TRANSFER_TOOLS = ["transfer_credits", "send_usdc"];

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Deny x402 payments above the configured per-payment max.
 */
function createX402MaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_max_single",
    description: `Deny x402 payments above ${policy.maxX402PaymentCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // The amount is checked pre-payment in x402Fetch itself,
      // but we also enforce via policy for the declared max.
      // x402 payment amounts aren't in tool args — they come from the server.
      // This rule serves as a policy declaration; actual enforcement
      // happens in x402Fetch when maxPaymentCents is injected.
      return null;
    },
  };
}

/**
 * Deny x402 requests to domains not in the allowlist.
 */
function createX402DomainAllowlistRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.x402_domain_allowlist",
    description: "Deny x402 to domains not in allowlist",
    priority: 500,
    appliesTo: { by: "name", names: ["x402_fetch"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const url = request.args.url as string | undefined;
      if (!url) return null;

      const allowedDomains = policy.x402AllowedDomains;
      if (allowedDomains.length === 0) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          "x402 payments are disabled (empty allowlist)",
        );
      }

      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Invalid URL: ${url}`,
        );
      }

      const isAllowed = allowedDomains.some(
        (domain) =>
          hostname === domain || hostname.endsWith(`.${domain}`),
      );

      if (!isAllowed) {
        return deny(
          "financial.x402_domain_allowlist",
          "DOMAIN_NOT_ALLOWED",
          `Domain "${hostname}" not in x402 allowlist: [${allowedDomains.join(", ")}]`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny single transfers above the configured max.
 */
function createTransferMaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_max_single",
    description: `Deny transfers above ${policy.maxSingleTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: TRANSFER_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.maxSingleTransferCents) {
        return deny(
          "financial.transfer_max_single",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer of ${amount} cents exceeds single transfer max of ${policy.maxSingleTransferCents} cents ($${(policy.maxSingleTransferCents / 100).toFixed(2)})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if hourly transfer total would exceed cap.
 */
function createTransferHourlyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_hourly_cap",
    description: `Deny if hourly transfers exceed ${policy.maxHourlyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: TRANSFER_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Hourly")) {
        return deny(
          "financial.transfer_hourly_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed hourly cap: current ${check.currentHourlySpend} + ${amount} > ${check.limitHourly} cents ($${(check.limitHourly / 100).toFixed(2)}/hr)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if daily transfer total would exceed cap.
 */
function createTransferDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_daily_cap",
    description: `Deny if daily transfers exceed ${policy.maxDailyTransferCents} cents`,
    priority: 500,
    appliesTo: { by: "name", names: TRANSFER_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Daily")) {
        return deny(
          "financial.transfer_daily_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed daily cap: current ${check.currentDailySpend} + ${amount} > ${check.limitDaily} cents ($${(check.limitDaily / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny any financial operation that would bring balance below minimum reserve.
 *
 * Fork (Phase 3 step 4, owner-approved under rule 4): enforced for send_usdc
 * against the wallet USDC balance the heartbeat last read (kv
 * wallet_usdc_cache:<network>:<address>; rules are synchronous, so no chain
 * call here). No cached balance = denied (fail closed). The tool re-reads the
 * balance on chain before signing, so a stale cache can only make this
 * stricter or equal, never the only check. Conway tools (transfer_credits,
 * fund_child, x402_fetch) keep the upstream behaviour: their balance is
 * Conway credits, and they are hidden while Conway is off.
 */
function createMinimumReserveRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.minimum_reserve",
    description: `Deny if balance would drop below ${policy.minimumReserveCents} cents reserve`,
    priority: 500,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "x402_fetch", "fund_child", "send_usdc"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (request.tool.name !== "send_usdc") return null;
      const amount = request.args.amount_cents;
      if (typeof amount !== "number" || !Number.isFinite(amount)) return null; // the tool refuses it
      const address = String(request.context.identity?.address ?? "").toLowerCase();
      const key = `wallet_usdc_cache:${getActiveNetwork().caip2}:${address}`;
      let usdcCents: number | null = null;
      try {
        const row = request.context.db.raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
        const usdc = row ? Number(JSON.parse(row.value).usdc) : NaN;
        usdcCents = Number.isFinite(usdc) ? Math.floor(usdc * 100 + 1e-6) : null;
      } catch {
        usdcCents = null;
      }
      if (usdcCents === null) {
        return deny(
          "financial.minimum_reserve",
          "RESERVE_UNKNOWN",
          "Wallet balance not known yet (no balance read on this network); payment refused. Try again after the next balance check.",
        );
      }
      if (usdcCents - amount < policy.minimumReserveCents) {
        return deny(
          "financial.minimum_reserve",
          "RESERVE",
          `Payment of ${amount} cents would leave ${usdcCents - amount} cents in the wallet, below the ${policy.minimumReserveCents} cents reserve. Don't retry.`,
        );
      }
      return null;
    },
  };
}

/**
 * Fork (Phase 3 step 4, owner-approved under rule 4): send_usdc may only pay
 * recipients on the owner's transferAllowlist ("creator" resolved from the
 * config). Empty list = every payment denied. The tool checks the same list.
 */
function createTransferRecipientAllowlistRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_recipient_allowlist",
    description: "Deny send_usdc to recipients not on the owner's transferAllowlist",
    priority: 500,
    appliesTo: { by: "name", names: ["send_usdc"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const to = request.args.to_address;
      const allowed = resolveTransferAllowlist(policy, request.context.config?.creatorAddress);
      if (allowed.length === 0) {
        return deny("financial.transfer_recipient_allowlist", "PAYMENTS_OFF", "Payments are off: the owner's recipient list is empty.");
      }
      if (typeof to !== "string" || !isAddress(to, { strict: false }) || !allowed.includes(to.toLowerCase())) {
        return deny(
          "financial.transfer_recipient_allowlist",
          "RECIPIENT_NOT_ALLOWED",
          `Recipient ${JSON.stringify(to)} is not on the owner's recipient list. Don't retry.`,
        );
      }
      return null;
    },
  };
}

/**
 * Deny if too many transfer operations in a single turn.
 * Prevents iterative credit drain within one turn.
 */
function createTurnTransferLimitRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.turn_transfer_limit",
    description: `Deny more than ${policy.maxTransfersPerTurn} transfers per turn`,
    priority: 500,
    appliesTo: { by: "name", names: TRANSFER_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const count = request.turnContext.turnToolCallCount;

      if (count >= policy.maxTransfersPerTurn) {
        return deny(
          "financial.turn_transfer_limit",
          "TURN_TRANSFER_LIMIT",
          `Maximum ${policy.maxTransfersPerTurn} transfers per turn exceeded (current: ${count})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny inference calls if daily inference cost exceeds maxInferenceDailyCents.
 * Checks spend_tracking table for category 'inference'.
 */
function createInferenceDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.inference_daily_cap",
    description: `Deny inference if daily cost exceeds ${policy.maxInferenceDailyCents} cents`,
    priority: 500,
    appliesTo: { by: "category", categories: ["conway"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // Only apply to inference-related tools
      if (request.tool.name !== "chat" && request.tool.name !== "inference") {
        return null;
      }

      const spendTracker = request.turnContext.sessionSpend;
      const dailyInferenceSpend = spendTracker.getDailySpend("inference");

      if (dailyInferenceSpend >= policy.maxInferenceDailyCents) {
        return deny(
          "financial.inference_daily_cap",
          "INFERENCE_BUDGET_EXCEEDED",
          `Daily inference budget exceeded: ${dailyInferenceSpend} cents spent (max ${policy.maxInferenceDailyCents} cents / $${(policy.maxInferenceDailyCents / 100).toFixed(2)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Return 'quarantine' (not deny) for transfer amounts above
 * requireConfirmationAboveCents. This is a soft limit requiring confirmation.
 */
function createRequireConfirmationRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.require_confirmation",
    description: `Quarantine transfers above ${policy.requireConfirmationAboveCents} cents for confirmation`,
    priority: 500,
    appliesTo: { by: "name", names: TRANSFER_TOOLS },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.requireConfirmationAboveCents) {
        return {
          rule: "financial.require_confirmation",
          action: "quarantine",
          reasonCode: "CONFIRMATION_REQUIRED",
          humanMessage: `Transfer of ${amount} cents ($${(amount / 100).toFixed(2)}) exceeds confirmation threshold of ${policy.requireConfirmationAboveCents} cents ($${(policy.requireConfirmationAboveCents / 100).toFixed(2)})`,
        };
      }

      return null;
    },
  };
}

/**
 * Create all financial policy rules.
 */
export function createFinancialRules(
  treasuryPolicy: TreasuryPolicy,
): PolicyRule[] {
  return [
    createX402MaxSingleRule(treasuryPolicy),
    createX402DomainAllowlistRule(treasuryPolicy),
    createTransferMaxSingleRule(treasuryPolicy),
    createTransferHourlyCapRule(treasuryPolicy),
    createTransferDailyCapRule(treasuryPolicy),
    createMinimumReserveRule(treasuryPolicy),
    createTransferRecipientAllowlistRule(treasuryPolicy),
    createTurnTransferLimitRule(treasuryPolicy),
    createInferenceDailyCapRule(treasuryPolicy),
    createRequireConfirmationRule(treasuryPolicy),
  ];
}
