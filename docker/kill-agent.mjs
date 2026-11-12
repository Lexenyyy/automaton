#!/usr/bin/env node
/**
 * pnpm agent:kill (fork, Phase 1): stop the agent immediately.
 *
 * Kills (SIGKILL) every container of the compose project, including one-off
 * `compose run` containers such as `pnpm agent:run`, then removes them.
 * Never removes volumes or images: wallet, state and workspace are kept.
 * Safe to run anytime and repeatedly; exit 0 when nothing is left running.
 * The agent cannot block this: it has no access to Docker.
 *
 *   node docker/kill-agent.mjs [--project <name>]   (default: automaton)
 *
 * For a graceful stop (SIGTERM, state saved as sleeping) use pnpm agent:down.
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
const project = projectIndex >= 0 ? args[projectIndex + 1] : "automaton";
if (!project || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
  console.error("agent:kill: invalid --project name");
  process.exit(2);
}

function docker(dockerArgs) {
  const r = spawnSync("docker", dockerArgs, { encoding: "utf-8", timeout: 60_000 });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), error: r.error };
}

const label = `label=com.docker.compose.project=${project}`;
const ids = (all) => {
  const r = docker(["ps", ...(all ? ["-a"] : []), "-q", "--filter", label]);
  if (r.code !== 0) {
    console.error(`agent:kill: cannot reach Docker (${r.error?.message ?? r.err}). Is Docker Desktop running?`);
    process.exit(1);
  }
  return r.out ? r.out.split(/\s+/) : [];
};

const started = Date.now();
const running = ids(false);
if (running.length === 0) {
  console.log(`agent:kill: nothing running in project "${project}".`);
} else {
  const names = docker(["ps", "--filter", label, "--format", "{{.Names}}"]).out.split(/\s+/).filter(Boolean);
  const kill = docker(["kill", ...running]);
  if (kill.code !== 0) console.error(`agent:kill: docker kill reported: ${kill.err}`);
  console.log(`agent:kill: killed ${running.length} container(s): ${names.join(", ")}`);
}

// Remove the stopped containers too (volumes and images are never touched).
const leftovers = ids(true);
if (leftovers.length > 0) docker(["rm", "-f", ...leftovers]);

const still = ids(false);
if (still.length > 0) {
  console.error(`agent:kill: ${still.length} container(s) still running: ${still.join(", ")}`);
  process.exit(1);
}
console.log(`agent:kill: done in ${Date.now() - started} ms. Volumes kept.`);
process.exit(0);
