/**
 * Fork, run 5 (F5; owner-approved under rule 4, narrows only): with the
 * container sandbox, write_file is confined to the workspace (sandbox
 * workspaceDir). Before, it confined to /root, which the sandbox refuses, so
 * every write failed ("path outside the sandbox roots: /root/note.txt").
 */

import { describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const writeFile = createBuiltinTools("sbx").find((t) => t.name === "write_file")!;

function ctxFor(sandbox: any) {
  const conway = new MockConwayClient();
  const db = createTestDb();
  const ctx = {
    identity: createTestIdentity(),
    config: createTestConfig({ sandbox }),
    db,
    conway,
    inference: new MockInferenceClient(),
  } as any;
  return { ctx, conway, db };
}

const CONTAINER = { mode: "container", socketPath: "/run/automaton-sandbox/sandbox.sock", workspaceDir: "/workspace" };

describe("write_file with the container sandbox", () => {
  it("relative and absolute paths inside the workspace are written there", async () => {
    const { ctx, conway, db } = ctxFor(CONTAINER);
    try {
      expect(await writeFile.execute({ path: "note.txt", content: "a" }, ctx)).toBe("File written: /workspace/note.txt");
      expect(await writeFile.execute({ path: "notes/day1.md", content: "b" }, ctx)).toBe("File written: /workspace/notes/day1.md");
      expect(await writeFile.execute({ path: "/workspace/x/../y.txt", content: "c" }, ctx)).toBe("File written: /workspace/y.txt");
      expect(Object.keys(conway.files).sort()).toEqual(["/workspace/note.txt", "/workspace/notes/day1.md", "/workspace/y.txt"]);
    } finally {
      db.close();
    }
  });

  it("refuses paths outside the workspace, the workspace itself and ~", async () => {
    const { ctx, conway, db } = ctxFor(CONTAINER);
    try {
      for (const p of ["/root/note.txt", "/home/agent/a.txt", "../etc/passwd", "/workspace/../tmp/x", "/workspace", "/workspacefoo/a"]) {
        expect(await writeFile.execute({ path: p, content: "x" }, ctx)).toMatch(/^Blocked: write_file path .* outside your workspace \(\/workspace\)/);
      }
      expect(await writeFile.execute({ path: "~/a.txt", content: "x" }, ctx)).toMatch(/^Blocked: write_file path "~\/a.txt": "~" is not in your workspace/);
      expect(conway.files).toEqual({});
    } finally {
      db.close();
    }
  });

  it("uses a configured workspaceDir", async () => {
    const { ctx, conway, db } = ctxFor({ ...CONTAINER, workspaceDir: "/data/ws" });
    try {
      expect(await writeFile.execute({ path: "a.txt", content: "a" }, ctx)).toBe("File written: /data/ws/a.txt");
      expect(await writeFile.execute({ path: "/workspace/a.txt", content: "a" }, ctx)).toMatch(/^Blocked/);
      expect(Object.keys(conway.files)).toEqual(["/data/ws/a.txt"]);
    } finally {
      db.close();
    }
  });
});
