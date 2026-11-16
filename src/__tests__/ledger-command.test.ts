/**
 * Fork: owner ledger command shared by `automaton-cli ledger` and the
 * runtime's `--ledger` flag (pnpm agent:ledger / agent:ledger:grant).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6, MIGRATION_V12, applyMigrationV14 } from "../state/schema.js";
import { getLedgerBalanceCents, getRecentLedgerEntries, insertLedgerEntry } from "../state/ledger.js";
import { parseDollarsToCents, runLedgerCommand, LEDGER_USAGE } from "../state/ledger-command.js";

let db: BetterSqlite3.Database;
const testnet = { liveOnly: false };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  db.exec(MIGRATION_V12);
  applyMigrationV14(db);
});

afterEach(() => db.close());

describe("parseDollarsToCents", () => {
  it("accepts whole dollars and up to two decimals", () => {
    expect(parseDollarsToCents("5")).toBe(500);
    expect(parseDollarsToCents("5.00")).toBe(500);
    expect(parseDollarsToCents("0.1")).toBe(10);
    expect(parseDollarsToCents("-0.25")).toBe(-25);
  });

  it("rejects anything else", () => {
    for (const bad of [undefined, "", "abc", "5.001", "1e3", "$5", "5,00", "0x10"]) {
      expect(parseDollarsToCents(bad)).toBeNaN();
    }
  });
});

describe("runLedgerCommand grant", () => {
  it("adds an owner_grant entry and reports the balance", () => {
    const r = runLedgerCommand(db, ["grant", "5.00"], testnet);
    expect(r).toEqual({ code: 0, output: "Granted $5.00. Ledger balance: $5.00" });
    expect(getLedgerBalanceCents(db, testnet)).toBe(500);
    const [entry] = getRecentLedgerEntries(db, 1);
    expect(entry).toMatchObject({ kind: "owner_grant", amountCents: 500, livemode: true, source: "owner_cli", memo: "owner grant" });
  });

  it("stores the --memo", () => {
    runLedgerCommand(db, ["grant", "1", "--memo", "first run budget"], testnet);
    expect(getRecentLedgerEntries(db, 1)[0].memo).toBe("first run budget");
  });

  it("refuses zero, negative and malformed amounts without writing", () => {
    for (const amount of [undefined, "0", "-5", "five", "5.001"]) {
      const r = runLedgerCommand(db, amount === undefined ? ["grant"] : ["grant", amount], testnet);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(/^Usage: ledger grant/);
    }
    expect(getRecentLedgerEntries(db, 10)).toHaveLength(0);
  });
});

describe("runLedgerCommand adjust", () => {
  it("adds a signed adjustment with a memo", () => {
    runLedgerCommand(db, ["grant", "5"], testnet);
    const r = runLedgerCommand(db, ["adjust", "-0.25", "--memo", "fix"], testnet);
    expect(r).toEqual({ code: 0, output: "Adjusted -$0.25. Ledger balance: $4.75" });
  });

  it("requires a memo and a non-zero amount", () => {
    expect(runLedgerCommand(db, ["adjust", "-1"], testnet).code).toBe(1);
    expect(runLedgerCommand(db, ["adjust", "0", "--memo", "x"], testnet).code).toBe(1);
    expect(getRecentLedgerEntries(db, 10)).toHaveLength(0);
  });
});

describe("runLedgerCommand show", () => {
  it("is the default and lists balance, totals and entries", () => {
    runLedgerCommand(db, ["grant", "5.00"], testnet);
    for (const args of [[], ["show"]]) {
      const r = runLedgerCommand(db, args, testnet);
      expect(r.code).toBe(0);
      expect(r.output).toContain("Ledger (testnet: all entries)");
      expect(r.output).toContain("Balance:                 $5.00");
      expect(r.output).toContain("Lifetime inference cost: $0.00");
      expect(r.output).toMatch(/owner_grant\s+\$5\.00\s+\(1\)/);
      expect(r.output).toContain("Recent entries");
    }
  });

  it("counts only real money on mainnet", () => {
    insertLedgerEntry(db, { kind: "owner_grant", amountCents: 300, livemode: false, source: "t" });
    insertLedgerEntry(db, { kind: "owner_grant", amountCents: 200, livemode: true, source: "t" });
    expect(runLedgerCommand(db, [], { liveOnly: true }).output).toContain("Balance:                 $2.00");
    expect(runLedgerCommand(db, [], testnet).output).toContain("Balance:                 $5.00");
  });
});

it("rejects unknown subcommands", () => {
  expect(runLedgerCommand(db, ["withdraw", "5"], testnet)).toEqual({ code: 1, output: LEDGER_USAGE });
});
