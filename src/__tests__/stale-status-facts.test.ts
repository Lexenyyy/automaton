/**
 * Status snapshots are not long-term facts (fork, run-2 leftover):
 * migration V15 removes the stale ones; facts show their date.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { MIGRATION_V15, SCHEMA_VERSION, STALE_STATUS_FACT_KEYS } from "../state/schema.js";
import { SemanticMemoryManager } from "../memory/semantic.js";
import { factDate, recallFacts } from "../memory/tools.js";
import { formatMemoryBlock } from "../agent/context.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-facts-"));
  dbPath = path.join(dir, "state.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("migration V15", () => {
  it("removes exactly the three stale status keys on an existing database and keeps other facts", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    // A database as it was at schema 14, with run-1 status facts in it.
    let db = createDatabase(dbPath);
    const sm = new SemanticMemoryManager(db.raw);
    sm.store({ category: "self", key: "system_synopsis", value: "Creator: 0x0000000000000000000000000000000000000000", confidence: 1, source: "s1" });
    sm.store({ category: "financial", key: "last_known_balance", value: "Balance: $5.00", confidence: 1, source: "s1" });
    sm.store({ category: "financial", key: "usdc_balance", value: "USDC balance: 0", confidence: 1, source: "s1" });
    sm.store({ category: "self", key: "purpose", value: "test instance", confidence: 1, source: "s1" });
    sm.store({ category: "financial", key: "pricing_note", value: "keep me", confidence: 1, source: "s1" });
    db.raw.prepare("DELETE FROM schema_version WHERE version >= 15").run();
    db.close();

    db = createDatabase(dbPath); // runs V15
    const left = db.raw.prepare("SELECT category, key FROM semantic_memory ORDER BY key").all();
    expect(left).toEqual([
      { category: "financial", key: "pricing_note" },
      { category: "self", key: "purpose" },
    ]);
    // Running it again is harmless.
    expect(() => db.raw.exec(MIGRATION_V15)).not.toThrow();
    db.close();
    expect(STALE_STATUS_FACT_KEYS).toHaveLength(3);
  });
});

describe("facts show their date", () => {
  it("recall_facts output and the memory block include the update day", () => {
    const db = createDatabase(dbPath);
    try {
      new SemanticMemoryManager(db.raw).store({ category: "self", key: "purpose", value: "test instance", confidence: 1, source: "s1" });
      const day = new Date().toISOString().slice(0, 10);
      expect(recallFacts(db.raw, { category: "self" })).toContain(`, updated ${day})`);
      expect(recallFacts(db.raw, { query: "purpose" })).toContain(`, updated ${day})`);

      const block = formatMemoryBlock({
        workingMemory: [], episodicMemory: [], proceduralMemory: [], relationships: [], totalTokens: 10,
        semanticMemory: new SemanticMemoryManager(db.raw).getByCategory("self"),
      });
      expect(block).toContain(`- [self/purpose] test instance (updated ${day})`);
    } finally {
      db.close();
    }
  });

  it("an unknown date adds nothing", () => {
    expect(factDate("")).toBe("");
    expect(factDate(undefined)).toBe("");
    expect(factDate("2026-11-16 12:00:00")).toBe(", updated 2026-11-16");
  });
});
