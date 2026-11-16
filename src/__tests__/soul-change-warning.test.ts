/**
 * No "SOUL.md changed" warning when update_soul made the change; a warning
 * when the file changed outside it (fork, run 3).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { soulChangeWarning } from "../agent/system-prompt.js";
import { updateSoul } from "../soul/tools.js";
import { loadCurrentSoul } from "../soul/model.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "soul-warn-"));
  process.env.HOME = home;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** What buildSystemPrompt does on each turn: check, then remember the hash. */
function loadTurn(): string | null {
  const soul = loadCurrentSoul(db.raw)!;
  const warning = soulChangeWarning(db, soul.contentHash);
  db.setKV("soul_content_hash", soul.contentHash);
  return warning;
}

describe("soulChangeWarning", () => {
  it("is silent after the agent's own update_soul calls", async () => {
    expect((await updateSoul(db.raw, { corePurpose: "First purpose." }, "agent", "r1")).success).toBe(true);
    expect(loadTurn()).toBeNull();
    expect((await updateSoul(db.raw, { corePurpose: "Second purpose." }, "agent", "r2")).success).toBe(true);
    expect(loadTurn()).toBeNull();
    expect(loadTurn()).toBeNull();
  });

  it("warns once when SOUL.md changed outside update_soul", async () => {
    await updateSoul(db.raw, { corePurpose: "First purpose." }, "agent", "r1");
    expect(loadTurn()).toBeNull();
    const file = path.join(home, ".automaton", "SOUL.md");
    fs.appendFileSync(file, "\nInjected line.\n");
    expect(loadTurn()).toMatch(/^SOUL\.md changed outside update_soul \(does not match recorded version \d+\)$/);
    expect(loadTurn()).toBeNull(); // reported once, not every turn
  });

  it("without soul history it keeps the upstream check", () => {
    db.setKV("soul_content_hash", "old");
    expect(soulChangeWarning(db, "new")).toBe("SOUL.md content changed since last load");
    expect(soulChangeWarning(db, "old")).toBeNull();
  });
});
