/**
 * SOUL.md messages explain how the soul is managed (fork, run 3).
 * The block itself is unchanged; only the message says more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools, isSoulPath } from "../agent/tools.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

const tools = createBuiltinTools("test-sandbox-id");
const tool = (name: string) => tools.find((t) => t.name === name)!;

let db: AutomatonDatabase;
let conway: MockConwayClient;
let ctx: ToolContext;

beforeEach(() => {
  db = createTestDb();
  conway = new MockConwayClient();
  ctx = { identity: createTestIdentity(), config: createTestConfig(), db, conway, inference: new MockInferenceClient() };
});
afterEach(() => db.close());

const addSoulVersion = (v: number) =>
  db.raw.prepare(
    "INSERT INTO soul_history (id, version, content, content_hash, change_source, created_at) VALUES (?, ?, 'x', 'h', 'agent', '2026-11-16T10:00:00.000Z')",
  ).run(`h${v}`, v);

describe("SOUL.md paths", () => {
  it("recognizes SOUL.md by file name in any folder and case", () => {
    for (const p of ["SOUL.md", "/root/SOUL.md", "~/.automaton/SOUL.md", "/workspace/soul.md", "C:\\x\\SOUL.md"]) {
      expect(isSoulPath(p), p).toBe(true);
    }
    for (const p of ["SOUL.md.bak", "/root/notes.md", "", "/root/SOUL"]) expect(isSoulPath(p), p).toBe(false);
  });

  // write_file confines paths to /root with path.resolve, which is C:\root on
  // Windows (the known tools-security Windows failures). Linux-only, like the
  // sandbox tests; the Linux baseline runs them.
  const linuxOnly = it.skipIf(process.platform === "win32");

  linuxOnly("write_file to SOUL.md is still blocked and now explains update_soul / view_soul and the version", async () => {
    addSoulVersion(5);
    const write = vi.spyOn(conway, "writeFile");
    const r = await tool("write_file").execute({ path: "/root/.automaton/SOUL.md", content: "new soul" }, ctx);
    expect(r).toContain("Blocked: Cannot overwrite protected file.");
    expect(r).toContain("managed with update_soul (change) and view_soul (read); it exists (version 5, last updated 2026-11-16)");
    expect(write).not.toHaveBeenCalled();
  });

  linuxOnly("other protected files keep the plain message", async () => {
    const r = await tool("write_file").execute({ path: "/root/.automaton/constitution.md", content: "x" }, ctx);
    expect(r).toBe("Blocked: Cannot overwrite protected file. This is a hard-coded safety invariant.");
  });

  it("read_file SOUL.md explains instead of 'not found', without a sandbox call", async () => {
    const read = vi.spyOn(conway, "readFile");
    const exec = vi.spyOn(conway, "exec");
    expect(await tool("read_file").execute({ path: "SOUL.md" }, ctx)).toContain("it does not exist yet");
    addSoulVersion(3);
    const r = await tool("read_file").execute({ path: "/root/.automaton/SOUL.md" }, ctx);
    expect(r).toContain("it exists (version 3");
    expect(r).not.toMatch(/not found/i);
    expect(read).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
