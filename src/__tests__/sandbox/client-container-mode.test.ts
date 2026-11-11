/**
 * Fork Phase 1: in container mode the Conway client sends exec/writeFile/
 * readFile to the sandbox and never runs them in the runtime, not even when
 * the sandbox is unreachable.
 */

import fs from "node:fs";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => {
      throw new Error("execSync must not run in the runtime in container mode");
    }),
  };
});

import { execSync } from "child_process";
import { createConwayClient } from "../../conway/client.js";
import { resolveSandboxSocket, SandboxError } from "../../sandbox/transport.js";
import { DEFAULT_SANDBOX_SOCKET } from "../../types.js";
import { isWindows, tempSocketPath } from "./helpers.js";

describe("resolveSandboxSocket", () => {
  it("is local (null) when the setting is absent or local", () => {
    expect(resolveSandboxSocket(undefined, "")).toBeNull();
    expect(resolveSandboxSocket({ mode: "local" }, "")).toBeNull();
  });

  it("uses the default socket in container mode", () => {
    expect(resolveSandboxSocket({ mode: "container" }, "")).toBe(DEFAULT_SANDBOX_SOCKET);
    expect(resolveSandboxSocket({ mode: "container", socketPath: "/run/x/s.sock" }, "")).toBe("/run/x/s.sock");
  });

  it("refuses unknown modes, relative sockets and a Conway sandboxId together with container mode", () => {
    expect(() => resolveSandboxSocket({ mode: "docker" } as any, "")).toThrow(/Invalid sandbox.mode/);
    expect(() => resolveSandboxSocket({ mode: "container", socketPath: "rel.sock" }, "")).toThrow(/absolute/);
    expect(() => resolveSandboxSocket({ mode: "container" }, "sbx-123")).toThrow(/cannot be combined/);
    expect(() => resolveSandboxSocket("container" as any, "")).toThrow(/expected an object/);
  });

  it("makes createConwayClient refuse to start on an invalid setting", () => {
    expect(() =>
      createConwayClient({ apiUrl: "http://x", apiKey: "k", sandboxId: "", sandbox: { mode: "nope" } as any }),
    ).toThrow(/Invalid sandbox.mode/);
  });
});

describe.skipIf(isWindows)("Conway client in container mode", () => {
  let fake: http.Server;
  let socketPath: string;
  const calls: { route: string; body: any }[] = [];

  beforeAll(async () => {
    socketPath = tempSocketPath();
    fake = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        calls.push({ route: req.url ?? "", body });
        const reply =
          req.url === "/exec"
            ? { stdout: "from-sandbox", stderr: "", exitCode: 3 }
            : req.url === "/files/read"
              ? { content: "sandbox-content" }
              : { ok: true };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => fake.listen(socketPath, () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => fake.close(() => r()));
  });

  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  const client = (sock: string) =>
    createConwayClient({ apiUrl: "http://conway.invalid", apiKey: "k", sandboxId: "", sandbox: { mode: "container", socketPath: sock } });

  it("sends exec, writeFile and readFile to the sandbox", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const readSpy = vi.spyOn(fs, "readFileSync");
    const c = client(socketPath);

    expect(await c.exec("id", 1234)).toEqual({ stdout: "from-sandbox", stderr: "", exitCode: 3 });
    await c.writeFile("/workspace/a.txt", "data");
    expect(await c.readFile("~/.automaton/wallet.json")).toBe("sandbox-content");

    expect(calls).toEqual([
      { route: "/exec", body: { command: "id", timeoutMs: 1234 } },
      { route: "/files/write", body: { path: "/workspace/a.txt", content: "data" } },
      { route: "/files/read", body: { path: "~/.automaton/wallet.json" } },
    ]);
    expect(execSync).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy.mock.calls.some(([p]) => String(p).includes("wallet.json"))).toBe(false);
  });

  it("throws when the sandbox is unreachable and never falls back to the runtime", async () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const c = client(tempSocketPath());
    await expect(c.exec("id")).rejects.toThrow(SandboxError);
    await expect(c.exec("id")).rejects.toThrow(/will NOT be run in the runtime/);
    await expect(c.writeFile("/workspace/x", "y")).rejects.toThrow(SandboxError);
    await expect(c.readFile("/workspace/x")).rejects.toThrow(SandboxError);
    expect(execSync).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("refuses expose_port, because the sandbox has no network", async () => {
    await expect(client(socketPath).exposePort(8080)).rejects.toThrow(/not available in sandbox container mode/);
  });
});
