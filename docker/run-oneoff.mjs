#!/usr/bin/env node
/**
 * One-off runtime commands (fork, Phase 1): pnpm agent:init, agent:ledger,
 * agent:settings, agent:preflight, agent:run.
 *
 *   node docker/run-oneoff.mjs [--project <name>] [--needs-sandbox] [--tty] -- <runtime args...>
 *
 * Only one agent per project: `--run` and `--init` are refused while any
 * runtime container of the project is running (also one started from another
 * terminal); the message names it and says to stop it first (pnpm agent:down).
 * Other commands (ledger, settings, preflight) still run, with a note that the
 * agent is running.
 *
 * Without --needs-sandbox the runtime runs with `--no-deps`: the sandbox is
 * never started (init, ledger and settings only touch the wallet and state.db).
 *
 * With --needs-sandbox (preflight, run) compose starts the sandbox if needed.
 * Afterwards the sandbox is stopped and removed again, but ONLY if it was not
 * already running before AND no other runtime is running then, so a live
 * agent's sandbox is never touched. Volumes are never removed.
 *
 * --tty: keep an interactive terminal (agent:run, agent:init). Otherwise `-T`.
 * Exits with the runtime's exit code.
 */

import { spawn } from "node:child_process";
import {
  COMPOSE_FILE,
  DEFAULT_PROJECT,
  describeContainer,
  docker,
  isValidProject,
  runningContainers,
  runningRuntimes,
} from "./agent-instances.mjs";

const WHO = "run-oneoff";
/** Runtime commands that must never run next to a live agent. */
const REFUSED_WHILE_RUNNING = new Set(["--run", "--init"]);

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("usage: run-oneoff.mjs [--project <name>] [--needs-sandbox] [--tty] -- <runtime args...>");
  process.exit(2);
}
const opts = argv.slice(0, sep);
const runtimeArgs = argv.slice(sep + 1);
const projectIndex = opts.indexOf("--project");
const projectOpt = projectIndex >= 0 ? opts[projectIndex + 1] : undefined;
if (projectIndex >= 0 && !isValidProject(projectOpt)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}
const project = projectOpt ?? DEFAULT_PROJECT;
const needsSandbox = opts.includes("--needs-sandbox");
const tty = opts.includes("--tty");

const COMPOSE = ["compose", "-f", COMPOSE_FILE, ...(projectOpt ? ["-p", projectOpt] : [])];

// ─── one agent per project ────────────────────────────────────
const live = runningRuntimes(project, WHO);
if (live.length > 0) {
  const list = live.map((c) => `  ${describeContainer(c)}`).join("\n");
  const command = runtimeArgs.find((a) => REFUSED_WHILE_RUNNING.has(a));
  if (command) {
    console.error(
      `${WHO}: refusing ${command}: ${live.length} runtime container(s) of project "${project}" already running:\n${list}\n` +
        `${WHO}: stop it first with pnpm agent:down (or pnpm agent:kill). pnpm agent:status shows what it is doing.`,
    );
    process.exit(1);
  }
  console.error(`${WHO}: note: the agent is running (${live.length} runtime container(s)):\n${list}`);
}

const sandboxWasRunning = needsSandbox ? runningContainers(project, "sandbox", WHO).length > 0 : true;

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
  console.error(`${WHO}: could not start docker: ${err.message}`);
  cleanup();
  process.exit(1);
});
child.on("exit", (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});

function cleanup() {
  if (sandboxWasRunning) return;
  // Our own one-off runtime is gone by now (compose run --rm waits for its
  // removal). Any runtime still running uses this sandbox: leave it alone.
  const others = runningRuntimes(project, WHO);
  if (others.length > 0) {
    console.error(
      `${WHO}: sandbox left running: another runtime uses it: ${others.map((c) => c.name).join(", ")}.`,
    );
    return;
  }
  const stop = docker([...COMPOSE, "stop", "sandbox"]);
  const rm = docker([...COMPOSE, "rm", "-f", "sandbox"]);
  if (stop.code !== 0 || rm.code !== 0) {
    console.error(`${WHO}: could not stop the sandbox (${stop.err || rm.err}). Run pnpm agent:down.`);
  } else {
    console.error(`${WHO}: sandbox stopped (it was started for this command).`);
  }
}
