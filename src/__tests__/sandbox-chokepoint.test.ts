/**
 * Fork Phase 1: process choke point.
 *
 * In sandbox container mode the runtime (wallet, keys, config) must never
 * start a process; the agent's commands run in the sandbox container. This
 * test lists every source file that imports child_process. A new import
 * fails the test until it is reviewed.
 *
 * Step 2 (owner-approved) routed the remaining runtime call sites: the worker
 * harnesses no longer import child_process, the skills loader no longer
 * starts `which`, and the skills registry and upstream helper start a process
 * only in local mode (container-mode-callers.test.ts proves it).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: fs.readFileSync(full, "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(f.text))
    .map((f) => f.rel)
    .sort();
}

/** Reviewed: process starts that are fine in container mode. */
const ALLOWED = {
  // execLocal: only reachable in local mode; container mode returns before it
  // (see client-container-mode.test.ts).
  "conway/client.ts": "local mode only",
  // Runs inside the sandbox container, never in the runtime.
  "sandbox/server.ts": "sandbox container only",
  // git clone / curl: local mode only; container mode runs them in the sandbox.
  "skills/registry.ts": "local mode only",
  // git on the agent's own repo: refused in container mode (sandbox/mode.ts).
  "self-mod/upstream.ts": "local mode only",
};

describe("process choke point (sandbox container mode)", () => {
  it("scans a real source tree", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === "sandbox/server.ts")).toBe(true);
  });

  it("imports child_process only in reviewed files", () => {
    expect(filesMatching(/from\s+["'](node:)?child_process["']|import\(\s*["'](node:)?child_process["']\s*\)/)).toEqual(
      Object.keys(ALLOWED).sort(),
    );
  });

  // Owner addition 1: only runtime -> sandbox calls. The runtime opens no
  // listening socket; the only server is the sandbox server.
  it("listens only in the sandbox server (the runtime opens no port or socket)", () => {
    const count = (re: RegExp) => {
      const out: Record<string, number> = {};
      for (const { rel, text } of FILES) {
        const n = (text.match(new RegExp(re.source, "g")) ?? []).length;
        if (n > 0) out[rel] = n;
      }
      return out;
    };
    expect(count(/\.listen\s*\(/)).toEqual({
      "sandbox/server.ts": 1,
      // Text of /tmp/agent-card-server.js, written to and run in the sandbox.
      "registry/agent-card.ts": 1,
    });
    expect(count(/\bcreateServer\s*\(/)).toEqual({
      "sandbox/server.ts": 1,
      "registry/agent-card.ts": 1,
    });
    // No raw UDP sockets either.
    expect(count(/["'](node:)?dgram["']/)).toEqual({});
  });

  it("uses no other way to start a process (worker threads, cluster)", () => {
    expect(filesMatching(/["'](node:)?(worker_threads|cluster)["']/)).toEqual([]);
  });

  it("keeps execSync in client.ts behind the container-mode check", () => {
    const text = FILES.find((f) => f.rel === "conway/client.ts")!.text;
    const execFn = text.slice(text.indexOf("const exec = async"), text.indexOf("const resolveLocalPath"));
    const containerCheck = execFn.indexOf("if (containerSandbox) return containerSandbox.exec(");
    const localCall = execFn.indexOf("execLocal(command");
    expect(containerCheck).toBeGreaterThan(-1);
    expect(localCall).toBeGreaterThan(containerCheck);
  });

  it("keeps the container-mode guards in front of the remaining local-only spawns", () => {
    const registry = FILES.find((f) => f.rel === "skills/registry.ts")!.text;
    for (const fn of ["installSkillFromGit", "installSkillFromUrl"]) {
      const body = registry.slice(registry.indexOf(`export async function ${fn}`));
      expect(body.indexOf("if (options.containerSandbox)")).toBeGreaterThan(-1);
      expect(body.indexOf("execFileSync(")).toBeGreaterThan(body.indexOf("if (options.containerSandbox)"));
    }
    const upstream = FILES.find((f) => f.rel === "self-mod/upstream.ts")!.text;
    const gitFn = upstream.slice(upstream.indexOf("function git("));
    expect(gitFn.indexOf("isContainerSandboxActive()")).toBeGreaterThan(-1);
    expect(gitFn.indexOf("execFileSync(")).toBeGreaterThan(gitFn.indexOf("isContainerSandboxActive()"));
    // Every execFileSync in upstream.ts goes through git().
    expect((upstream.match(/execFileSync\(/g) ?? []).length).toBe(1);
  });
});
