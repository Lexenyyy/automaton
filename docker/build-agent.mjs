#!/usr/bin/env node
/**
 * pnpm agent:build (fork, Phase 1): build the runtime and sandbox images,
 * labelled with the git commit (`org.automaton.build-commit`; "-dirty" when the
 * working tree has uncommitted changes). The runtime logs it at startup and
 * pnpm agent:status shows it per running container.
 *
 * Afterwards it warns if a running agent still runs an older image: a rebuild
 * does not change a running container (incident 2026-11-16: fixes were built
 * and tested while the live agent kept running the old code).
 *
 *   node docker/build-agent.mjs [--project <name>] [extra compose build args...]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSE_FILE, DEFAULT_PROJECT, gitBuildCommit, isValidProject, warnStaleRuntimes } from "./agent-instances.mjs";

const WHO = "agent:build";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const pi = args.indexOf("--project");
const project = pi >= 0 ? args[pi + 1] : DEFAULT_PROJECT;
if (!isValidProject(project)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}
const extra = pi >= 0 ? args.filter((_, i) => i !== pi && i !== pi + 1) : args;

const commit = gitBuildCommit(ROOT);
console.log(`${WHO}: building images for commit ${commit} ...`);
const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "build", ...extra], {
  stdio: "inherit",
  env: { ...process.env, AUTOMATON_BUILD_COMMIT: commit },
});
if (r.status !== 0) {
  console.error(`${WHO}: build failed (exit ${r.status ?? r.error?.message}).`);
  process.exit(r.status || 1);
}
console.log(`${WHO}: images built from ${commit}.`);
warnStaleRuntimes(project, WHO);
process.exit(0);
