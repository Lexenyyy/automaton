/**
 * Shared helper (fork, Phase 1): which runtime containers of a compose project
 * are running. Used by run-oneoff.mjs (refuse a second agent), status-agent.mjs
 * (pnpm agent:status) and down-agent.mjs.
 *
 * A runtime is any running container labelled with the project and the
 * `runtime` service: `docker compose up` ones and one-off `compose run` ones
 * (pnpm agent:run). Docker errors end the process with exit 1.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPOSE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "compose.agent.yml");
export const DEFAULT_PROJECT = "automaton";

export function isValidProject(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

export function docker(args, timeoutMs = 120_000) {
  const r = spawnSync("docker", args, { encoding: "utf-8", timeout: timeoutMs });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), error: r.error };
}

function dockerOrExit(args, who) {
  const r = docker(args);
  if (r.code !== 0) {
    console.error(`${who}: cannot reach Docker (${r.error?.message ?? r.err}). Is Docker Desktop running?`);
    process.exit(1);
  }
  return r.out;
}

/** Running containers of the project for one service, with start time and image. */
export function runningContainers(project, service, who = "agent") {
  const out = dockerOrExit(
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`],
    who,
  );
  const ids = out ? out.split(/\s+/) : [];
  if (ids.length === 0) return [];
  const info = JSON.parse(dockerOrExit(["inspect", ...ids], who));
  return info
    .filter((c) => c.State?.Running)
    .map((c) => ({
      id: c.Id.slice(0, 12),
      name: (c.Name ?? "").replace(/^\//, ""),
      startedAt: c.State.StartedAt,
      imageId: c.Image,
      oneoff: (c.Config?.Labels ?? {})["com.docker.compose.oneoff"] === "True",
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export const runningRuntimes = (project, who) => runningContainers(project, "runtime", who);

export function formatUptime(ms) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** "name (one-off, up 1 h 03 min, started 2026-11-16 15:35:08 UTC)" */
export function describeContainer(c, now = Date.now()) {
  const started = new Date(c.startedAt);
  const when = started.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `${c.name} (${c.oneoff ? "one-off, " : ""}up ${formatUptime(now - started.getTime())}, started ${when})`;
}
