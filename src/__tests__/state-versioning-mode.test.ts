/**
 * State versioning is off in container mode and never reaches the sandbox
 * for ~/.automaton (fork, Phase 1).
 */

import { describe, expect, it, vi } from "vitest";
import { initStateVersioning } from "../git/state-versioning.js";
import type { ConwayClient } from "../types.js";

function recordingClient() {
  const calls: string[] = [];
  const client = {
    exec: vi.fn(async (cmd: string) => {
      calls.push(`exec ${cmd}`);
      return { stdout: "nope", stderr: "", exitCode: 0 };
    }),
    writeFile: vi.fn(async (p: string) => {
      calls.push(`write ${p}`);
    }),
  } as unknown as ConwayClient;
  return { client, calls };
}

describe("initStateVersioning", () => {
  it("is off in container mode and makes no sandbox call", async () => {
    const { client, calls } = recordingClient();
    const r = await initStateVersioning(client, {
      mode: "container",
      socketPath: "/run/automaton-sandbox/sandbox.sock",
      workspaceDir: "/workspace",
    } as any);
    expect(r).toEqual({ status: "off", reason: "container mode; history is kept in the database" });
    expect(calls).toEqual([]);
  });

  it("initializes the repo in local mode", async () => {
    const { client, calls } = recordingClient();
    const r = await initStateVersioning(client, undefined);
    expect(r.status).toBe("initialized");
    expect(calls.some((c) => c.startsWith("write ") && c.endsWith("/.automaton/.gitignore"))).toBe(true);
  });
});
