/**
 * Fork Phase 1: process choke point.
 *
 * In sandbox container mode the runtime (wallet, keys, config) must never
 * start a process; the agent's commands run in the sandbox container. This
 * test lists every source file that imports child_process. A new import
 * fails the test until it is reviewed.
 *
 * PENDING (step 2, owner decision): five runtime call sites still start
 * processes outside the conway.exec choke point. They are listed below so the
 * list cannot grow silently; each must be routed through the sandbox (or
 * removed) before container mode is used for real.
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
};

/** NOT yet routed through the sandbox. Step 2 of the Docker plan. */
const PENDING_STEP_2 = {
  "agent/harnesses/coding-harness.ts": "orchestrator worker shell (exec)",
  "agent/harnesses/general-harness.ts": "orchestrator worker shell (exec)",
  "self-mod/upstream.ts": "git on the agent's own repo",
  "skills/loader.ts": "`which` for skill requires.bins",
  "skills/registry.ts": "git clone / curl to install skills",
};

describe("process choke point (sandbox container mode)", () => {
  it("scans a real source tree", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === "sandbox/server.ts")).toBe(true);
  });

  it("imports child_process only in reviewed files", () => {
    expect(filesMatching(/from\s+["'](node:)?child_process["']|import\(\s*["'](node:)?child_process["']\s*\)/)).toEqual(
      Object.keys({ ...ALLOWED, ...PENDING_STEP_2 }).sort(),
    );
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
});
