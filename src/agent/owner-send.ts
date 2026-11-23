/**
 * Owner USDC send (fork, Phase 4 step 7): `automaton --wallet send <cents|all>
 * [--reason "..."] [--confirm]`, used to drain the tier-walk wallet.
 *
 *   - Pays ONLY the creator address from the config. No recipient can be
 *     given: any extra argument (an address, --to, ...) is refused.
 *   - The same path as an agent payment: the send_usdc tool body
 *     (executeSendUsdc: amount, recipient list, UTC hour/day windows, reserve,
 *     decimals, gas) behind the policy engine with the default rules, under
 *     the active template's treasuryPolicy.
 *   - Prints the project, network, agent wallet, recipient, amount, wallet
 *     USDC and survival balance/tier before → after, and the limits.
 *   - Without --confirm it is a dry run: every check, nothing signed, nothing
 *     recorded. With --confirm: recorded like an agent payment
 *     (onchain_transactions with initiator "owner", spend_tracking, a policy
 *     decision, an INFO log line). No ledger entry: the wallet balance is read
 *     on chain, a ledger entry would count the payment twice.
 *   - "all" sends the whole wallet USDC (the last drain step of the walk).
 * The caller refuses it while an agent runs (run-oneoff and the runtime lease).
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonTool, ToolContext, TreasuryPolicy } from "../types.js";
import type { NetworkInfo } from "../identity/network.js";
import { PolicyEngine } from "./policy-engine.js";
import { createDefaultRules } from "./policy-rules/index.js";
import { SpendTracker } from "./spend-tracker.js";
import { executeTool } from "./tools.js";
import { executeSendUsdc, UNITS_PER_CENT, type UsdcChain } from "./usdc-transfer.js";
import { describePaymentLimits } from "./payment-limits.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getLedgerBalanceCents } from "../state/ledger.js";
import { walletCacheKey } from "../survival/balance.js";
import type { SurvivalThresholds } from "../survival/settings.js";

type Database = BetterSqlite3.Database;

export const OWNER_SEND_USAGE =
  'Usage: automaton --wallet send <cents|all> [--reason "..."] [--confirm]   (pays only the creator address; dry run without --confirm)';
export const DEFAULT_OWNER_SEND_REASON = "owner wallet send";

export type OwnerSendArgs = { amount: number | "all"; confirm: boolean; reason: string };

/** Arguments after `--wallet send`. Any recipient or unknown argument is refused. */
export function parseOwnerSendArgs(args: readonly string[]): OwnerSendArgs | { error: string } {
  let amount: number | "all" | undefined;
  let confirm = false;
  let reason = DEFAULT_OWNER_SEND_REASON;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--confirm") confirm = true;
    else if (a === "--reason") {
      const r = args[++i];
      if (r === undefined || r.startsWith("--")) return { error: `--reason needs a text. ${OWNER_SEND_USAGE}` };
      reason = r;
    } else if (amount === undefined && (a === "all" || /^\d+$/.test(a))) {
      amount = a === "all" ? "all" : Number(a);
    } else if (/^0x[0-9a-fA-F]{40}$/.test(a) || a === "--to") {
      return { error: `Refused: --wallet send pays only the creator address from the config; no recipient can be given (got ${JSON.stringify(a)}).` };
    } else {
      return { error: `Unknown argument ${JSON.stringify(a)}. ${OWNER_SEND_USAGE}` };
    }
  }
  if (amount === undefined) return { error: `No amount. ${OWNER_SEND_USAGE}` };
  if (amount !== "all" && amount < 1) return { error: `The amount must be at least 1 cent. ${OWNER_SEND_USAGE}` };
  return { amount, confirm, reason };
}

export interface OwnerSendDeps {
  db: Database;
  ctx: ToolContext;
  sendTool: AutomatonTool;
  network: NetworkInfo;
  chain: UsdcChain;
  policy: TreasuryPolicy;
  survival: SurvivalThresholds;
  /** Compose project name (run-oneoff passes AUTOMATON_PROJECT). */
  project: string | null;
}

const usdc = (cents: number) => `${(cents / 100).toFixed(2)} USDC`;
const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

export async function runOwnerSend(d: OwnerSendDeps, a: OwnerSendArgs): Promise<{ code: number; output: string }> {
  const creator = d.ctx.config.creatorAddress;
  const from = d.ctx.identity.address as `0x${string}`;
  if (!creator) return { code: 1, output: "No creator address (set AUTOMATON_CREATOR_ADDRESS); nothing sent." };

  let walletCents: number;
  try {
    const units = await d.chain.usdcBalance(from);
    walletCents = Number(units / UNITS_PER_CENT);
    // The reserve rule reads this cache: give it the fresh read (same key and format as the heartbeat).
    d.db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(walletCacheKey(d.network.caip2, from), JSON.stringify({ usdc: Number(units) / 1_000_000, at: new Date().toISOString() }));
  } catch (err: any) {
    return { code: 1, output: `Cannot read the wallet balance on ${d.network.label} (${err?.message ?? err}); nothing sent.` };
  }
  const amount = a.amount === "all" ? walletCents : a.amount;
  if (amount < 1) return { code: 1, output: `The wallet holds ${usdc(walletCents)}; nothing to send.` };

  const ledger = getLedgerBalanceCents(d.db, { liveOnly: d.network.mode === "mainnet" });
  const before = ledger + walletCents;
  const after = before - amount;
  const lines = [
    `=== OWNER USDC SEND (pays the creator only) — ${a.confirm ? "CONFIRMED" : "DRY RUN (add --confirm to send)"} ===`,
    `Project:          ${d.project ?? "(unknown: not started through run-oneoff)"}`,
    `Network:          ${d.network.label}`,
    `Agent wallet:     ${from}`,
    `To (creator):     ${creator}`,
    `Amount:           ${usdc(amount)}${a.amount === "all" ? " (all)" : ""}`,
    `Wallet USDC:      ${usdc(walletCents)} → ${usdc(walletCents - amount)} after`,
    `Survival balance: ${usd(before)} (${getSurvivalTier(before, d.survival)}) → ${usd(after)} (${getSurvivalTier(after, d.survival)}) after` +
      ` [ledger ${usd(ledger)} + wallet]`,
    `Limits:           ${describePaymentLimits(d.policy, creator)}`,
    `Reason:           ${a.reason}`,
  ];

  const args = { to_address: creator, amount_cents: amount, reason: a.reason };
  const engine = new PolicyEngine(d.db, createDefaultRules(d.policy));
  const turnContext = { inputSource: "creator" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(d.db) };

  if (!a.confirm) {
    // Dry run: the policy engine (not logged) and every send_usdc check; nothing signed or recorded.
    const decision = engine.evaluate({ tool: d.sendTool, args, context: d.ctx, turnContext });
    if (decision.action !== "allow") {
      lines.push(`REFUSED by policy: ${decision.reasonCode} — ${decision.humanMessage}`);
      return { code: 1, output: lines.join("\n") };
    }
    const r = await executeSendUsdc(args, d.ctx, d.chain, { dryRun: true, initiator: "owner" });
    lines.push(r.ok ? `${r.message} Run again with --confirm to send.` : `REFUSED: ${r.message}`);
    return { code: r.ok ? 0 : 1, output: lines.join("\n") };
  }

  // Confirmed: the agent's own path (executeTool + policy engine, decision logged).
  const tool: AutomatonTool = {
    ...d.sendTool,
    execute: async (toolArgs, ctx) => (await executeSendUsdc(toolArgs, ctx, d.chain, { initiator: "owner" })).message,
  };
  const r = await executeTool("send_usdc", args, [tool], d.ctx, engine, turnContext);
  const text = r.error ? r.error : r.result;
  const sent = /^(Sent |Payment of .* was sent)/.test(text);
  lines.push(sent ? `RESULT: ${text}` : `REFUSED: ${text}`);
  return { code: sent ? 0 : 1, output: lines.join("\n") };
}
