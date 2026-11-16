/**
 * Owner ledger command (fork): show, grant, adjust.
 *
 * Shared by `automaton-cli ledger ...` and the runtime's `--ledger ...` flag
 * (pnpm agent:ledger / agent:ledger:grant in Docker). Owner only: the agent has
 * no tool that reaches this code, and its shell is blocked from state.db.
 *
 * Amounts are dollars ("5", "5.00", "-0.25"). Entries are real money (livemode).
 * The ledger is append-only: corrections are new 'adjustment' entries.
 */

import type BetterSqlite3 from "better-sqlite3";
import {
  insertLedgerEntry,
  getLedgerBalanceCents,
  getLedgerTotalsByKind,
  getLifetimeInferenceCostCents,
  getRecentLedgerEntries,
  getUncountedCurrencyCount,
} from "./ledger.js";

type Database = BetterSqlite3.Database;

export interface LedgerCommandResult {
  /** Process exit code: 0 ok, 1 usage error. */
  code: number;
  output: string;
}

export const LEDGER_USAGE =
  'Usage: ledger [show | grant <amount> [--memo "..."] | adjust <±amount> --memo "..."]   (amounts in dollars)';

/** "5", "5.00", "-0.25" → cents. NaN for anything else (max 2 decimals). */
export function parseDollarsToCents(rawAmount: string | undefined): number {
  if (!rawAmount || !/^-?\d+(\.\d{1,2})?$/.test(rawAmount.trim())) return NaN;
  return Math.round(Number(rawAmount) * 100);
}

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Runs one ledger subcommand. `args` starts at the subcommand
 * (e.g. ["grant", "5.00", "--memo", "test budget"]). `liveOnly` is true on mainnet.
 */
export function runLedgerCommand(
  db: Database,
  args: readonly string[],
  opts: { liveOnly: boolean },
): LedgerCommandResult {
  const sub = args[0];
  const memoIndex = args.indexOf("--memo");
  const memo = memoIndex >= 0 ? args[memoIndex + 1] : undefined;
  const balance = () => usd(getLedgerBalanceCents(db, { liveOnly: opts.liveOnly }));

  switch (sub) {
    case "grant": {
      const cents = parseDollarsToCents(args[1]);
      if (!Number.isFinite(cents) || cents <= 0) {
        return { code: 1, output: 'Usage: ledger grant <amount> [--memo "..."]   (amount in dollars, > 0)' };
      }
      insertLedgerEntry(db, { kind: "owner_grant", amountCents: cents, livemode: true, source: "owner_cli", memo: memo ?? "owner grant" });
      return { code: 0, output: `Granted ${usd(cents)}. Ledger balance: ${balance()}` };
    }
    case "adjust": {
      const cents = parseDollarsToCents(args[1]);
      if (!Number.isFinite(cents) || cents === 0 || !memo) {
        return { code: 1, output: 'Usage: ledger adjust <±amount> --memo "reason"   (memo required)' };
      }
      insertLedgerEntry(db, { kind: "adjustment", amountCents: cents, livemode: true, source: "owner_cli", memo });
      return { code: 0, output: `Adjusted ${usd(cents)}. Ledger balance: ${balance()}` };
    }
    case "show":
    case undefined: {
      const lines: string[] = [];
      lines.push(`\nLedger (${opts.liveOnly ? "mainnet: real money only" : "testnet: all entries"})`);
      lines.push(`  Balance:                 ${balance()}`);
      lines.push(`  Lifetime inference cost: ${usd(getLifetimeInferenceCostCents(db))}`);
      for (const t of getLedgerTotalsByKind(db)) {
        lines.push(`  ${t.kind.padEnd(18)} ${usd(t.totalCents).padStart(10)}  (${t.count})`);
      }
      const uncounted = getUncountedCurrencyCount(db);
      if (uncounted > 0) lines.push(`  Warning: ${uncounted} non-USD entries are not counted.`);
      lines.push("\nRecent entries");
      for (const e of getRecentLedgerEntries(db, 15)) {
        lines.push(`  ${e.recordedAt}  ${e.kind.padEnd(16)} ${usd(e.amountCents).padStart(9)} ${e.currency}${e.livemode ? "" : " (test)"}  ${e.memo}`);
      }
      lines.push("");
      return { code: 0, output: lines.join("\n") };
    }
    default:
      return { code: 1, output: LEDGER_USAGE };
  }
}
