#!/usr/bin/env node
/**
 * One-off runtime commands (fork, Phase 1): pnpm agent:init, agent:ledger,
 * agent:settings, agent:preflight, agent:run.
 *
 *   node docker/run-oneoff.mjs [--project <name>] [--needs-sandbox] [--tty] -- <runtime args...>
 *
 * Without --needs-sandbox the runtime runs with `--no-deps`: the sandbox is
 * never started (init, ledger and settings only touch the wallet and state.db).
 *
 * With --needs-sandbox (preflight, run) compose starts the sandbox if needed.
 * Afterwards the sandbox is stopped and removed again, but ONLY if it was not
 * already running before, so a live agent's sandbox is never touched.
 * Volumes are never removed.
 *
 * --tty: keep an interactive terminal (agent:run, agent:init). Otherwise `-T`.
 * Exits with the runtime's exit code.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "compose.agent.yml");

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("usage: run-oneoff.mjs [--project <name>] [--needs-sandbox] [--tty] -- <runtime args...>");
  process.exit(2);
}
const opts = argv.slice(0, sep);
const runtimeArgs = argv.slice(sep + 1);
const projectIndex = opts.indexOf("--project");
const project = projectIndex >= 0 ? opts[projectIndex + 1] : undefined;
if (projectIndex >= 0 && (!project || !/^[a-z0-9][a-z0-9_-]*$/.test(project))) {
  console.error("run-oneoff: invalid --project name");
  process.exit(2);
}
const needsSandbox = opts.includes("--needs-sandbox");
const tty = opts.includes("--tty");

const COMPOSE = ["compose", "-f", COMPOSE_FILE, ...(project ? ["-p", project] : [])];

function dockerSync(args) {
  const r = spawnSync("docker", args, { encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), error: r.error };
}

function sandboxRunning() {
  const r = dockerSync([...COMPOSE, "ps", "--status", "running", "-q", "sandbox"]);
  if (r.code !== 0) {
    console.error(`run-oneoff: cannot reach Docker (${r.error?.message ?? r.err}). Is Docker Desktop running?`);
    process.exit(1);
  }
  return r.out !== "";
}

const sandboxWasRunning = needsSandbox ? sandboxRunning() : true;

const runArgs = [
  ...COMPOSE, "run", "--rm",
  ...(tty ? [] : ["-T"]),
  ...(needsSandbox ? [] : ["--no-deps"]),
  "runtime", ...runtimeArgs,
];

// Ctrl+C reaches the runtime through compose (graceful stop). This process
// only waits for it to exit, then cleans up.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => {});

const child = spawn("docker", runArgs, { stdio: "inherit" });
child.on("error", (err) => {
  console.error(`run-oneoff: could not start docker: ${err.message}`);
  cleanup();
  process.exit(1);
});
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});

function cleanup() {
  if (sandboxWasRunning) return;
  const stop = dockerSync([...COMPOSE, "stop", "sandbox"]);
  const rm = dockerSync([...COMPOSE, "rm", "-f", "sandbox"]);
  if (stop.code !== 0 || rm.code !== 0) {
    console.error(`run-oneoff: could not stop the sandbox (${stop.err || rm.err}). Run pnpm agent:down.`);
  } else {
    console.error("run-oneoff: sandbox stopped (it was started for this command).");
  }
}
