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

/** Image tags from compose.agent.yml, per service. */
export const SERVICE_IMAGES = { runtime: "automaton-runtime:local", sandbox: "automaton-sandbox:local" };
export const COMMIT_LABEL = "org.automaton.build-commit";

/** Git commit of the working tree for image labels: short hash, "-dirty" with uncommitted changes. */
export function gitBuildCommit(cwd) {
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 });
  const head = git(["rev-parse", "--short=12", "HEAD"]);
  if (head.status !== 0) return "unknown";
  const dirty = (git(["status", "--porcelain"]).stdout ?? "").trim() !== "";
  return `${head.stdout.trim()}${dirty ? "-dirty" : ""}`;
}

/** Image ID the service tag points to now ("" if the image does not exist). */
export function currentImageId(service) {
  const r = docker(["image", "inspect", "-f", "{{.Id}}", SERVICE_IMAGES[service]]);
  return r.code === 0 ? r.out : "";
}

/** Build commit label of an image (by ID or tag), or "unknown". */
export function imageCommit(image) {
  const r = docker(["image", "inspect", "-f", `{{index .Config.Labels "${COMMIT_LABEL}"}}`, image]);
  return r.code === 0 && r.out && r.out !== "<no value>" ? r.out : "unknown";
}

/**
 * Running containers of the project for one service, with start time, image,
 * build commit, and `stale` = the service image was rebuilt after the container
 * was created (it still runs the old code).
 */
export function runningContainers(project, service, who = "agent") {
  const out = dockerOrExit(
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`],
    who,
  );
  const ids = out ? out.split(/\s+/) : [];
  if (ids.length === 0) return [];
  const info = JSON.parse(dockerOrExit(["inspect", ...ids], who));
  const current = currentImageId(service);
  return info
    .filter((c) => c.State?.Running)
    .map((c) => ({
      id: c.Id.slice(0, 12),
      name: (c.Name ?? "").replace(/^\//, ""),
      startedAt: c.State.StartedAt,
      imageId: c.Image,
      oneoff: (c.Config?.Labels ?? {})["com.docker.compose.oneoff"] === "True",
      commit: (c.Config?.Labels ?? {})[COMMIT_LABEL] || "unknown",
      stale: current !== "" && c.Image !== current,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export const runningRuntimes = (project, who) => runningContainers(project, "runtime", who);

/**
 * After a build: warn when a runtime of the project still runs an older image.
 * Returns the number of such runtimes.
 */
export function warnStaleRuntimes(project, who) {
  const stale = runningRuntimes(project, who).filter((c) => c.stale);
  if (stale.length > 0) {
    console.error(
      `${who}: WARNING: the running agent of project "${project}" still runs the OLD code:\n` +
        stale.map((c) => `  ${describeContainer(c)}`).join("\n") +
        `\n${who}: the new build (${imageCommit(SERVICE_IMAGES.runtime)}) takes effect only after pnpm agent:down and pnpm agent:run.`,
    );
  }
  return stale.length;
}

export function formatUptime(ms) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** "name (one-off, up 1 h 03 min, started 2026-11-16 15:35:08 UTC, build abc123) OLD IMAGE: ..." */
export function describeContainer(c, now = Date.now()) {
  const started = new Date(c.startedAt);
  const when = started.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const text = `${c.name} (${c.oneoff ? "one-off, " : ""}up ${formatUptime(now - started.getTime())}, started ${when}, build ${c.commit})`;
  return c.stale ? `${text} OLD IMAGE: rebuilt since, it still runs the old code` : text;
}
