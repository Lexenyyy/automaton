/**
 * automaton-cli ledger show
 * automaton-cli ledger grant <amount> [--memo "..."]
 * automaton-cli ledger adjust <±amount> --memo "..."
 *
 * Owner-only view and entries for the agent's local ledger (fork change 3).
 * Amounts are dollars ("5", "5.00", "-0.25"). Entries are real money (livemode).
 * The ledger is append-only: corrections are new 'adjustment' entries.
 */

import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { createDatabase } from "@conway/automaton/state/database.js";
import {
  insertLedgerEntry,
  getLedgerBalanceCents,
  getLedgerTotalsByKind,
  getLifetimeInferenceCostCents,
  getRecentLedgerEntries,
  getUncountedCurrencyCount,
} from "@conway/automaton/state/ledger.js";

const args = process.argv.slice(3);
const sub = args[0];

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

const db = createDatabase(resolvePath(config.dbPath));
const raw = db.raw;
const liveOnly = config.network === "mainnet";
const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

function memoArg(): string | undefined {
  const i = args.indexOf("--memo");
  return i >= 0 ? args[i + 1] : undefined;
}

function parseDollarsToCents(rawAmount: string | undefined): number {
  if (!rawAmount || !/^-?\d+(\.\d{1,2})?$/.test(rawAmount.trim())) return NaN;
  return Math.round(Number(rawAmount) * 100);
}

try {
  switch (sub) {
    case "grant": {
      const cents = parseDollarsToCents(args[1]);
      if (!Number.isFinite(cents) || cents <= 0) {
        console.log("Usage: automaton-cli ledger grant <amount> [--memo \"...\"]   (amount in dollars, > 0)");
        process.exit(1);
      }
      insertLedgerEntry(raw, { kind: "owner_grant", amountCents: cents, livemode: true, source: "owner_cli", memo: memoArg() ?? "owner grant" });
      console.log(`Granted ${usd(cents)}. Ledger balance: ${usd(getLedgerBalanceCents(raw, { liveOnly }))}`);
      break;
    }
    case "adjust": {
      const cents = parseDollarsToCents(args[1]);
      const memo = memoArg();
      if (!Number.isFinite(cents) || cents === 0 || !memo) {
        console.log("Usage: automaton-cli ledger adjust <±amount> --memo \"reason\"   (memo required)");
        process.exit(1);
      }
      insertLedgerEntry(raw, { kind: "adjustment", amountCents: cents, livemode: true, source: "owner_cli", memo });
      console.log(`Adjusted ${usd(cents)}. Ledger balance: ${usd(getLedgerBalanceCents(raw, { liveOnly }))}`);
      break;
    }
    case "show":
    case undefined: {
      console.log(`\nLedger (${liveOnly ? "mainnet: real money only" : "testnet: all entries"})`);
      console.log(`  Balance:                 ${usd(getLedgerBalanceCents(raw, { liveOnly }))}`);
      console.log(`  Lifetime inference cost: ${usd(getLifetimeInferenceCostCents(raw))}`);
      for (const t of getLedgerTotalsByKind(raw)) {
        console.log(`  ${t.kind.padEnd(18)} ${usd(t.totalCents).padStart(10)}  (${t.count})`);
      }
      const uncounted = getUncountedCurrencyCount(raw);
      if (uncounted > 0) console.log(`  Warning: ${uncounted} non-USD entries are not counted.`);
      console.log("\nRecent entries");
      for (const e of getRecentLedgerEntries(raw, 15)) {
        console.log(`  ${e.recordedAt}  ${e.kind.padEnd(16)} ${usd(e.amountCents).padStart(9)} ${e.currency}${e.livemode ? "" : " (test)"}  ${e.memo}`);
      }
      console.log();
      break;
    }
    default:
      console.log("Usage: automaton-cli ledger [show | grant <amount> [--memo ...] | adjust <±amount> --memo ...]");
      process.exit(1);
  }
} finally {
  db.close();
}
