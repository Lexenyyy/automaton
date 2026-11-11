/**
 * Fork Phase 1: sandbox server (runs only in the sandbox container).
 * Exec tests need /bin/sh and process groups, so they run on Linux only
 * (`pnpm test:linux`); file tests run everywhere.
 */

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandboxServer } from "../../sandbox/server.js";
import { createSandboxTransport, SandboxError } from "../../sandbox/transport.js";
import { TIMEOUT_EXIT_CODE } from "../../sandbox/protocol.js";
import { isWindows, tempDir, tempSocketPath } from "./helpers.js";

let server: http.Server;
let socketPath: string;
let workspace: string;
let home: string;
let outside: string;

beforeAll(async () => {
  workspace = tempDir("sbx-ws-");
  home = tempDir("sbx-home-");
  outside = tempDir("sbx-outside-");
  socketPath = tempSocketPath();
  server = await startSandboxServer({ socketPath, roots: [workspace, home], home });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of [workspace, home, outside]) fs.rmSync(d, { recursive: true, force: true });
});

describe("sandbox server: files", () => {
  it("writes and reads a file inside a root, creating folders", async () => {
    const t = createSandboxTransport(socketPath);
    const file = path.join(workspace, "a", "b.txt");
    await t.writeFile(file, "hello");
    expect(fs.readFileSync(file, "utf-8")).toBe("hello");
    expect(await t.readFile(file)).toBe("hello");
  });

  it("expands ~/ to the sandbox home", async () => {
    const t = createSandboxTransport(socketPath);
    await t.writeFile("~/note.md", "x");
    expect(fs.readFileSync(path.join(home, "note.md"), "utf-8")).toBe("x");
  });

  it("refuses paths outside the roots, including .. escapes", async () => {
    const t = createSandboxTransport(socketPath);
    await expect(t.writeFile(path.join(outside, "x.txt"), "no")).rejects.toThrow(/outside the sandbox roots/);
    await expect(t.writeFile(path.join(workspace, "..", path.basename(outside), "x.txt"), "no")).rejects.toThrow(
      /outside the sandbox roots/,
    );
    await expect(t.readFile(path.join(outside, "x.txt"))).rejects.toThrow(/outside the sandbox roots/);
    expect(fs.existsSync(path.join(outside, "x.txt"))).toBe(false);
  });

  it("refuses relative paths", async () => {
    const t = createSandboxTransport(socketPath);
    await expect(t.writeFile("relative.txt", "no")).rejects.toThrow(/absolute/);
  });

  it.skipIf(isWindows)("refuses a symlink inside a root that points outside", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(workspace, "link"));
    const t = createSandboxTransport(socketPath);
    await expect(t.readFile(path.join(workspace, "link", "secret.txt"))).rejects.toThrow(/outside the sandbox roots/);
    await expect(t.writeFile(path.join(workspace, "link", "new.txt"), "no")).rejects.toThrow(/outside the sandbox roots/);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("returns a clear error for a missing file", async () => {
    const t = createSandboxTransport(socketPath);
    const err = await t.readFile(path.join(workspace, "missing.txt")).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.status).toBe(404);
  });
});

describe.skipIf(isWindows)("sandbox server: exec", () => {
  it("runs a command in the sandbox home and passes the exit code", async () => {
    const t = createSandboxTransport(socketPath);
    const ok = await t.exec("pwd; echo out; echo err >&2");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(`${home}\nout\n`);
    expect(ok.stderr).toBe("err\n");
    expect((await t.exec("exit 7")).exitCode).toBe(7);
  });

  it("gives commands a fixed environment, nothing inherited from the server", async () => {
    process.env.SANDBOX_TEST_FAKE_SECRET = "must-not-leak";
    try {
      const t = createSandboxTransport(socketPath);
      const res = await t.exec("env");
      expect(res.stdout).not.toContain("must-not-leak");
      const names = res.stdout
        .trim()
        .split("\n")
        .map((l) => l.split("=")[0])
        .filter((n) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(n))
        .sort();
      expect(names).toEqual(["HOME", "LANG", "PATH"]);
    } finally {
      delete process.env.SANDBOX_TEST_FAKE_SECRET;
    }
  });

  it("kills the whole process group on timeout", async () => {
    const t = createSandboxTransport(socketPath);
    const marker = path.join(workspace, "late.txt");
    const started = Date.now();
    const res = await t.exec(`(sleep 2; touch ${marker}) & sleep 30`, 300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(res.stderr).toMatch(/timed out/);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("stops a command that floods its output", async () => {
    const t = createSandboxTransport(socketPath);
    const res = await t.exec("yes", 20_000);
    expect(res.stderr).toMatch(/output limit/);
    expect(res.exitCode).not.toBe(0);
  });
});
