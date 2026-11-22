/**
 * Owner payment-limits test (fork, Phase 3 step 7): `pnpm agent:payment-test`.
 *
 * Runs send_usdc through the same path the agent loop uses (executeTool +
 * the policy engine with the default rules), without a model call:
 *   - ONE real transfer inside the limits: 0.10 USDC to the creator;
 *   - refusals with the configured limits: above the per-transfer limit, a
 *     recipient not on the list, a second transfer in the same turn;
 *   - refusals with TIGHTENED copies of the configured limits (each value
 *     only ever stricter): the hourly / daily limit set to what was already
 *     sent this hour / today, and the reserve raised to the current balance.
 *     A 2 USDC wallet cannot exceed the real windows without being drained;
 *   - the tool's own checks without the policy engine (second layer).
 * Every refusal must leave nothing signed and no new transaction or spend row.
 * Testnet only; refused while an agent runs (the caller checks the lease).
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonTool, ToolContext, TreasuryPolicy } from "../types.js";
import type { NetworkInfo } from "../identity/network.js";
import { PolicyEngine } from "./policy-engine.js";
import { createDefaultRules } from "./policy-rules/index.js";
import { SpendTracker } from "./spend-tracker.js";
import { executeTool } from "./tools.js";
import { executeSendUsdc, UNITS_PER_CENT, type UsdcChain } from "./usdc-transfer.js";
import { resolveTransferAllowlist } from "./payment-limits.js";

type Database = BetterSqlite3.Database;

export const TEST_AMOUNT_CENTS = 10;
/** Never paid (every case using it must be refused); the well-known burn address. */
export const NOT_LISTED_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

export interface PaymentTestCase {
  name: string;
  expect: "sent" | "refused";
  ok: boolean;
  detail: string;
}

export interface PaymentTestDeps {
  db: Database;
  ctx: ToolContext;
  sendTool: AutomatonTool;
  network: NetworkInfo;
  chain: UsdcChain;
  policy: TreasuryPolicy;
}

const counts = (db: Database) => ({
  tx: (db.prepare("SELECT COUNT(*) c FROM onchain_transactions").get() as { c: number }).c,
  spend: (db.prepare("SELECT COUNT(*) c FROM spend_tracking").get() as { c: number }).c,
});

/** Preconditions; a list of problems (empty = ready). */
export async function paymentTestPreconditions(d: PaymentTestDeps): Promise<string[]> {
  const p: string[] = [];
  if (d.network.mode !== "testnet") p.push(`network is ${d.network.label}; the payment test runs on testnet only`);
  const creator = d.ctx.config.creatorAddress?.toLowerCase();
  if (!creator || !resolveTransferAllowlist(d.policy, d.ctx.config.creatorAddress).includes(creator)) {
    p.push('the creator address is not on treasuryPolicy.transferAllowlist (set AUTOMATON_CREATOR_ADDRESS; template lists "creator")');
  }
  if (TEST_AMOUNT_CENTS > d.policy.maxSingleTransferCents) p.push(`maxSingleTransferCents is below the ${TEST_AMOUNT_CENTS}-cent test amount`);
  try {
    const usdc = Number((await d.chain.usdcBalance(d.ctx.identity.address as `0x${string}`)) / UNITS_PER_CENT);
    const need = TEST_AMOUNT_CENTS + d.policy.minimumReserveCents;
    if (usdc < need) p.push(`wallet has ${(usdc / 100).toFixed(2)} USDC; the test needs ${(need / 100).toFixed(2)} (amount + reserve)`);
    if ((await d.chain.ethBalance(d.ctx.identity.address as `0x${string}`)) === 0n) p.push("wallet has no ETH for the network fee");
  } catch (err: any) {
    p.push(`cannot read balances (${err?.message ?? err})`);
  }
  return p;
}

/** Writes the on-chain USDC balance to the cache the reserve rule reads (same key and format as the heartbeat). */
async function refreshBalanceCache(d: PaymentTestDeps): Promise<number> {
  const units = await d.chain.usdcBalance(d.ctx.identity.address as `0x${string}`);
  const cents = Number(units / UNITS_PER_CENT);
  d.db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(`wallet_usdc_cache:${d.network.caip2}:${d.ctx.identity.address.toLowerCase()}`, JSON.stringify({ usdc: cents / 100, at: new Date().toISOString() }));
  return cents;
}

export async function runPaymentTest(d: PaymentTestDeps): Promise<{ ok: boolean; cases: PaymentTestCase[] }> {
  // Count every broadcast attempt, so a refusal that still signed is caught.
  let broadcasts = 0;
  const chain: UsdcChain = { ...d.chain, sendTransfer: async (to, units) => { broadcasts++; return d.chain.sendTransfer(to, units); } };
  const tool: AutomatonTool = { ...d.sendTool, execute: async (args, ctx) => (await executeSendUsdc(args, ctx, chain)).message };
  const cases: PaymentTestCase[] = [];
  const creator = d.ctx.config.creatorAddress;

  const call = async (name: string, args: Record<string, unknown>, opts: { policy?: TreasuryPolicy; turnCount?: number; expect: "sent" | "refused"; engine?: boolean }) => {
    const policy = opts.policy ?? d.policy;
    const ctx: ToolContext = { ...d.ctx, config: { ...d.ctx.config, treasuryPolicy: policy } };
    const before = counts(d.db);
    const b0 = broadcasts;
    let text: string;
    if (opts.engine === false) {
      text = (await executeSendUsdc(args, ctx, chain)).message;
    } else {
      const r = await executeTool("send_usdc", args, [tool], ctx, new PolicyEngine(d.db, createDefaultRules(policy)), {
        inputSource: "agent",
        turnToolCallCount: opts.turnCount ?? 0,
        sessionSpend: new SpendTracker(d.db),
      });
      text = r.error ? r.error : r.result;
    }
    const after = counts(d.db);
    const sent = /^(Sent |Payment of .* was sent)/.test(text);
    const ok = opts.expect === "sent"
      ? sent && broadcasts === b0 + 1
      : !sent && broadcasts === b0 && after.tx === before.tx && after.spend === before.spend;
    cases.push({ name, expect: opts.expect, ok, detail: text });
    return ok;
  };

  const reason = "owner payment-limits test (Phase 3 step 7)";
  await refreshBalanceCache(d);

  // 1. One real transfer inside the limits.
  const sentOk = await call(`inside the limits: ${(TEST_AMOUNT_CENTS / 100).toFixed(2)} USDC to the creator`,
    { to_address: creator, amount_cents: TEST_AMOUNT_CENTS, reason }, { expect: "sent" });
  const balanceCents = await refreshBalanceCache(d);
  const tracker = new SpendTracker(d.db);
  const hourSent = tracker.getHourlySpend("transfer");
  const daySent = tracker.getDailySpend("transfer");

  // 2–4. Configured limits.
  await call(`per-transfer limit: ${d.policy.maxSingleTransferCents + 1} cents`,
    { to_address: creator, amount_cents: d.policy.maxSingleTransferCents + 1, reason }, { expect: "refused" });
  await call("recipient not on the list", { to_address: NOT_LISTED_RECIPIENT, amount_cents: 1, reason }, { expect: "refused" });
  await call("second transfer in the same turn", { to_address: creator, amount_cents: 1, reason }, { expect: "refused", turnCount: 1 });

  // 5–7. Tightened copies (each value only stricter than configured).
  const tighter = (over: Partial<TreasuryPolicy>): TreasuryPolicy => ({ ...d.policy, ...over });
  if (sentOk) {
    await call(`hourly limit (tightened to the ${hourSent} cents already sent this hour)`,
      { to_address: creator, amount_cents: 1, reason }, { expect: "refused", policy: tighter({ maxHourlyTransferCents: Math.min(hourSent, d.policy.maxHourlyTransferCents) }) });
    await call(`daily limit (tightened to the ${daySent} cents already sent today)`,
      { to_address: creator, amount_cents: 1, reason }, { expect: "refused", policy: tighter({ maxDailyTransferCents: Math.min(daySent, d.policy.maxDailyTransferCents) }) });
  }
  await call(`reserve (raised to the current balance, ${balanceCents} cents)`,
    { to_address: creator, amount_cents: 1, reason }, { expect: "refused", policy: tighter({ minimumReserveCents: Math.max(balanceCents, d.policy.minimumReserveCents) }) });

  // 8–9. The tool's own checks, without the policy engine.
  await call("tool layer alone: recipient not on the list", { to_address: NOT_LISTED_RECIPIENT, amount_cents: 1, reason }, { expect: "refused", engine: false });
  await call("tool layer alone: per-transfer limit", { to_address: creator, amount_cents: d.policy.maxSingleTransferCents + 1, reason }, { expect: "refused", engine: false });

  return { ok: cases.every((c) => c.ok), cases };
}

export function formatPaymentTest(r: { ok: boolean; cases: PaymentTestCase[] }): string {
  const lines = ["=== PAYMENT LIMITS TEST (no model call) ==="];
  for (const c of r.cases) lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name} [expected: ${c.expect}]\n      ${c.detail}`);
  lines.push(`=== ${r.ok ? "PAYMENT TEST PASSED" : "PAYMENT TEST FAILED"} ===`);
  return lines.join("\n");
}
