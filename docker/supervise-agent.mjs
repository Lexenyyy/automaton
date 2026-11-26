#!/usr/bin/env node
/**
 * pnpm agent:supervise (fork, Phase 2): run the agent and restart it after a
 * crash, with a crash-loop limit. For unattended runs (the 72 h run, the VPS).
 *
 *   node docker/supervise-agent.mjs [--project <name>] [--max-restarts <n>]
 *        [--window-minutes <m>] [--restart-delay <s>] [--resume] [-- <first-start args>]
 *
 * It starts the runtime like `pnpm agent:run` (run-oneoff.mjs, same checks:
 * one agent per project, template/project pairing) and waits for it to exit.
 * Rules (supervise-policy.mjs):
 *   - agent:down / agent:kill write a stop marker first: the supervisor does
 *     not restart, and exits 0. A graceful stop (exit 0) also ends it.
 *   - lease lost (exit 3): another runtime uses the database; it gives up.
 *   - any other exit is a crash: restart after --restart-delay seconds
 *     (default 120, at least 100: the crashed runtime's lease must expire),
 *     at most --max-restarts (default 3) per --window-minutes (default 60).
 *     One more crash: it gives up, leaves the agent stopped and exits 2.
 * A restart honours a pending sleep (no --wake-now); first-start args after
 * `--` (e.g. --wake-now) apply to the first start only.
 * While a stop marker exists (the owner stopped the agent), the supervisor
 * refuses to start; --resume clears it. Ctrl+C / SIGTERM: graceful stop
 * through agent:down (which writes the marker), then exit 0.
 * The runtime's output and the supervisor's own lines go to the console and to
 * ~/.automaton-logs/supervise-<project>-<start>.log (AUTOMATON_LOG_DIR); its
 * state is in ~/.automaton-logs/supervise-<project>.json for agent:watch.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT, isValidProject, logDir, runningRuntimes } from "./agent-instances.mjs";
import {
  clearStopMarker,
  decideAfterExit,
  pidAlive,
  readStopMarker,
  readSupervisorState,
  superviseSettings,
  writeSupervisorState,
} from "./supervise-policy.mjs";

const WHO = "agent:supervise";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const firstStartArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (name) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : undefined;
};

const projectOpt = opt("--project");
if (opts.includes("--project") && !isValidProject(projectOpt)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}
const project = projectOpt ?? DEFAULT_PROJECT;
const parsed = superviseSettings({
  maxRestarts: opt("--max-restarts"),
  windowMinutes: opt("--window-minutes"),
  restartDelaySeconds: opt("--restart-delay"),
});
if (parsed.error) {
  console.error(`${WHO}: ${parsed.error}`);
  process.exit(2);
}
const settings = parsed.settings;
const badFirst = firstStartArgs.filter((a) => a !== "--wake-now");
if (badFirst.length > 0) {
  console.error(`${WHO}: only --wake-now is accepted after -- (got ${badFirst.join(" ")})`);
  process.exit(2);
}

const dir = logDir();
fs.mkdirSync(dir, { recursive: true });
const started = new Date();
const logFile = path.join(dir, `supervise-${project}-${started.toISOString().replace(/[:.]/g, "-")}.log`);
const write = (text) => fs.appendFileSync(logFile, text);
const say = (line) => {
  const text = `${new Date().toISOString()} ${WHO}: ${line}`;
  console.log(text);
  write(`${text}\n`);
};

// One supervisor per project.
const previous = readSupervisorState(dir, project);
if (previous && ["running", "waiting"].includes(previous.state) && previous.pid !== process.pid && pidAlive(previous.pid)) {
  console.error(`${WHO}: another supervisor of project "${project}" is running (pid ${previous.pid}, state ${previous.state}). Refusing.`);
  process.exit(1);
}

// The owner stopped the agent: do not start it again unless asked to.
const marker = readStopMarker(dir, project);
if (marker && !opts.includes("--resume")) {
  console.error(
    `${WHO}: the agent of project "${project}" was stopped by ${marker.by ?? "the owner"} at ${marker.at ?? "?"}; not starting it. ` +
      `Start with --resume to clear that and run it.`,
  );
  process.exit(0);
}
if (runningRuntimes(project, WHO).length > 0) {
  console.error(`${WHO}: a runtime of project "${project}" is already running. Stop it first (pnpm agent:down), then supervise.`);
  process.exit(1);
}
if (marker) {
  clearStopMarker(dir, project);
  console.log(`${WHO}: --resume: cleared the stop marker (${marker.by ?? "?"} at ${marker.at ?? "?"}).`);
}

const restarts = [];
let state = "starting";
let child = null;
let stopping = false;
let wakeTimer = null;
let wakeResolve = null;

const saveState = (extra = {}) =>
  writeSupervisorState(dir, project, {
    pid: process.pid,
    project,
    state,
    startedAt: started.toISOString(),
    updatedAt: new Date().toISOString(),
    restarts: restarts.map((t) => new Date(t).toISOString()),
    settings,
    logFile,
    ...extra,
  });

function startRuntime(first) {
  const args = [
    path.join(HERE, "run-oneoff.mjs"),
    ...(projectOpt ? ["--project", projectOpt] : []),
    "--needs-sandbox", "--", "--run", ...(first ? firstStartArgs : []),
  ];
  state = "running";
  saveState({ runtimeStartedAt: new Date().toISOString() });
  say(`starting the runtime${first ? "" : " again (a pending sleep is honoured)"}${first && firstStartArgs.length ? ` (${firstStartArgs.join(" ")})` : ""}.`);
  const c = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child = c;
  c.stdout.on("data", (d) => {
    process.stdout.write(d);
    write(d);
  });
  c.stderr.on("data", (d) => {
    process.stderr.write(d);
    write(d);
  });
  return new Promise((resolve) => {
    c.on("error", (err) => resolve({ exitCode: null, signal: `spawn error: ${err.message}` }));
    // "close": after the output streams ended, so the last lines are in the log first.
    c.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function stopGracefully(sig) {
  if (stopping) return;
  stopping = true;
  say(`${sig}: stopping the agent gracefully (agent:down), no restart.`);
  // agent:down writes the stop marker, then stops the runtime (our child exits).
  const r = spawnSync(process.execPath, [path.join(HERE, "down-agent.mjs"), ...(projectOpt ? ["--project", projectOpt] : [])], {
    encoding: "utf-8",
    timeout: 240_000,
  });
  for (const l of `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")) if (l) say(`  ${l}`);
  if (wakeResolve) {
    clearTimeout(wakeTimer);
    wakeResolve();
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stopGracefully(sig));

say(
  `supervising project "${project}": restart after a crash in ${settings.restartDelaySeconds} s, at most ` +
    `${settings.maxRestarts} restart(s) per ${settings.windowMinutes} min. Stop with Ctrl+C or pnpm agent:down. Log: ${logFile}`,
);

let first = true;
for (;;) {
  const { exitCode, signal } = await startRuntime(first);
  first = false;
  child = null;
  const now = Date.now();
  const d = decideAfterExit({ exitCode, signal, stopMarker: readStopMarker(dir, project), restarts, now, settings });
  if (d.action === "stop" || stopping) {
    state = "stopped";
    saveState({ reason: d.reason });
    say(`${d.reason}. Not restarting. Supervisor done.`);
    process.exit(0);
  }
  if (d.action === "give_up") {
    state = "gave_up";
    saveState({ reason: d.reason });
    say(`GAVE UP: ${d.reason}. The agent stays stopped. Read the log above, then start it again yourself.`);
    process.exit(2);
  }
  const nextStartAt = new Date(now + settings.restartDelaySeconds * 1000).toISOString();
  state = "waiting";
  saveState({ reason: d.reason, nextStartAt });
  say(`${d.reason} (at ${nextStartAt}).`);
  await new Promise((resolve) => {
    wakeResolve = resolve;
    wakeTimer = setTimeout(resolve, settings.restartDelaySeconds * 1000);
  });
  wakeResolve = null;
  const lateMarker = readStopMarker(dir, project);
  if (stopping || lateMarker) {
    state = "stopped";
    saveState({ reason: "stopped by the owner while waiting to restart" });
    say(`stopped by ${lateMarker?.by ?? "the owner"} while waiting to restart. Not restarting. Supervisor done.`);
    process.exit(0);
  }
  restarts.push(Date.now());
}
