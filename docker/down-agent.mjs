#!/usr/bin/env node
/**
 * pnpm agent:down (fork, Phase 1): stop the agent gracefully.
 *
 * `docker compose down` does not stop containers made by `docker compose run`
 * (one-off containers such as `pnpm agent:run`), so the runtime kept running
 * and the network stayed in use. This script:
 *   1. sends SIGTERM to every running runtime container of the project,
 *      one-off ones included, and waits up to --timeout seconds (default 30).
 *      The runtime then admits no new model call, waits for in-flight calls to
 *      be recorded, saves its state as sleeping and exits. Docker force-stops
 *      (SIGKILL) a container that is still running at the timeout;
 *   2. stops the sandbox and any other container of the project;
 *   3. removes the stopped containers and runs `docker compose down` (network).
 * Never removes volumes or images: wallet, state and workspace are kept.
 * Exit 0 when nothing of the project is left running.
 *
 *   node docker/down-agent.mjs [--project <name>] [--timeout <seconds>]
 *
 * For an immediate stop use pnpm agent:kill.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "compose.agent.yml");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const project = opt("--project") ?? "automaton";
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
  console.error("agent:down: invalid --project name");
  process.exit(2);
}
const timeout = Number(opt("--timeout") ?? 30);
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
  console.error("agent:down: --timeout must be a whole number of seconds (1-600)");
  process.exit(2);
}

function docker(dockerArgs, timeoutMs = 120_000) {
  const r = spawnSync("docker", dockerArgs, { encoding: "utf-8", timeout: timeoutMs });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), error: r.error };
}

const label = `label=com.docker.compose.project=${project}`;
function ids(filters, all = false) {
  const r = docker(["ps", ...(all ? ["-a"] : []), "-q", "--filter", label, ...filters.flatMap((f) => ["--filter", f])]);
  if (r.code !== 0) {
    console.error(`agent:down: cannot reach Docker (${r.error?.message ?? r.err}). Is Docker Desktop running?`);
    process.exit(1);
  }
  return r.out ? r.out.split(/\s+/) : [];
}
const nameOf = (id) => docker(["inspect", "-f", "{{.Name}}", id]).out.replace(/^\//, "") || id;

/** Exit code of a container once it stops (works for --rm containers too). */
function exitCodeWhenStopped(id) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["wait", id], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(/^\d+$/.test(out.trim()) ? Number(out.trim()) : null));
    p.on("error", () => resolve(null));
  });
}

const started = Date.now();
let problems = 0;

// 1. Runtime containers (service and one-off), graceful.
const runtimes = ids(["label=com.docker.compose.service=runtime"]);
if (runtimes.length > 0) {
  const names = new Map(runtimes.map((id) => [id, nameOf(id)]));
  console.log(`agent:down: stopping ${runtimes.length} runtime container(s) (SIGTERM, up to ${timeout}s): ${[...names.values()].join(", ")}`);
  const waits = runtimes.map((id) => exitCodeWhenStopped(id));
  docker(["stop", "-t", String(timeout), ...runtimes], (timeout + 60) * 1000);
  const codes = await Promise.all(waits);
  runtimes.forEach((id, i) => {
    const code = codes[i];
    if (code === 0) {
      console.log(`agent:down: ${names.get(id)} stopped gracefully (exit 0).`);
    } else if (code === 137) {
      problems++;
      console.error(`agent:down: ${names.get(id)} did not stop within ${timeout}s and was force-stopped (exit 137).`);
    } else {
      console.log(`agent:down: ${names.get(id)} stopped (exit ${code ?? "unknown"}).`);
    }
  });
}

// 2. Everything else of the project (sandbox, other one-offs).
const others = ids([]);
if (others.length > 0) {
  docker(["stop", "-t", "10", ...others], 90_000);
  console.log(`agent:down: stopped ${others.length} other container(s): ${others.map(nameOf).join(", ")}`);
}

// 3. Remove stopped containers (volumes are never touched), then the network.
const leftovers = ids([], true);
if (leftovers.length > 0) docker(["rm", "-f", ...leftovers]);
const down = docker(["compose", "-f", COMPOSE_FILE, "-p", project, "down", "--remove-orphans"]);
if (down.code !== 0) {
  problems++;
  console.error(`agent:down: docker compose down reported: ${down.err}`);
}

const still = ids([]);
if (still.length > 0) {
  console.error(`agent:down: ${still.length} container(s) still running: ${still.join(", ")}. Use pnpm agent:kill.`);
  process.exit(1);
}
console.log(`agent:down: done in ${Date.now() - started} ms. Volumes kept.${problems ? " See the messages above." : ""}`);
console.log(
  `agent:down: no runtime of project "${project}" is running now. Any later pnpm agent:run (from any terminal) ` +
    "starts a new one; pnpm agent:status shows what is running.",
);
process.exit(problems ? 1 : 0);
