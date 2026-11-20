/**
 * Owner facts command (fork, run 6 follow-up H3).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runFactsCommand, parseFactRef } from "../memory/facts-command.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

function addFact(db: AutomatonDatabase, id: string, category: string, key: string, value: string): void {
  db.raw.prepare(
    "INSERT INTO semantic_memory (id, category, key, value, confidence, source) VALUES (?, ?, ?, ?, 1.0, 'test')",
  ).run(id, category, key, value);
}
const keys = (db: AutomatonDatabase) =>
  (db.raw.prepare("SELECT category || '/' || key k FROM semantic_memory ORDER BY k").all() as { k: string }[]).map((r) => r.k);

describe("facts command", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    addFact(db, "1", "environment", "tool_error:write_file:POLICY_BLOCKED", "write_file fails (161x)");
    addFact(db, "2", "self", "last_observation", "Balance $4.27");
    addFact(db, "3", "self", "latest_observation", "Balance $4.44");
  });
  afterEach(() => db.close());

  it("lists facts (the default)", () => {
    const r = runFactsCommand(db.raw, [], { agentRunning: null });
    expect(r.code).toBe(0);
    expect(r.output).toContain("FACTS (semantic_memory): 3");
    expect(r.output).toContain("environment/tool_error:write_file:POLICY_BLOCKED");
  });

  it("deletes exact category/key matches", () => {
    const r = runFactsCommand(db.raw, ["delete", "environment/tool_error:write_file:POLICY_BLOCKED", "self/latest_observation"], { agentRunning: null });
    expect(r.code).toBe(0);
    expect(r.output).toContain("Deleted 2 fact(s)");
    expect(keys(db)).toEqual(["self/last_observation"]);
  });

  it("deletes nothing when any key is missing", () => {
    const r = runFactsCommand(db.raw, ["delete", "self/latest_observation", "self/nope"], { agentRunning: null });
    expect(r.code).toBe(1);
    expect(r.output).toContain("Not found (nothing deleted): self/nope");
    expect(keys(db)).toHaveLength(3);
  });

  it("refuses to delete while an agent runs", () => {
    const r = runFactsCommand(db.raw, ["delete", "self/latest_observation"], { agentRunning: "instance x, heartbeat 5 s ago" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Refusing to delete facts while an agent is running/);
    expect(keys(db)).toHaveLength(3);
  });

  it("rejects bad usage", () => {
    expect(runFactsCommand(db.raw, ["delete"], { agentRunning: null }).code).toBe(2);
    expect(runFactsCommand(db.raw, ["purge"], { agentRunning: null }).code).toBe(2);
    expect(runFactsCommand(db.raw, ["delete", "nokey"], { agentRunning: null }).code).toBe(2);
    expect(parseFactRef("self/a/b")).toEqual({ category: "self", key: "a/b" });
    expect(parseFactRef("/x")).toBeNull();
    expect(parseFactRef("x/")).toBeNull();
  });
});
