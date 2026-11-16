#!/usr/bin/env node
/**
 * pnpm agent:logs (fork, Phase 2 prep): show the log of the newest runtime
 * container of the project (the running one, else the newest stopped one,
 * e.g. a detached run that ended). Read-only.
 *
 *   node docker/logs-agent.mjs [--project <name>] [-f|--follow] [--tail <n>]
 *
 * Saved logs of removed containers are in ~/.automaton-logs (AUTOMATON_LOG_DIR).
 */

import { spawn } from "node:child_process";
import { DEFAULT_PROJECT, allRuntimeContainers, isValidProject, logDir } from "./agent-instances.mjs";

const WHO = "agent:logs";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const project = opt("--project") ?? DEFAULT_PROJECT;
if (!isValidProject(project)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}
const tail = opt("--tail");
if (tail !== undefined && !/^\d+$/.test(tail)) {
  console.error(`${WHO}: --tail must be a number of lines`);
  process.exit(2);
}
const follow = args.includes("-f") || args.includes("--follow");

const all = allRuntimeContainers(project, WHO);
const target = all.find((c) => c.running) ?? all[0];
if (!target) {
  console.error(`${WHO}: no runtime container of project "${project}". Saved logs: ${logDir()}`);
  process.exit(1);
}
console.error(
  `${WHO}: ${target.name} (${target.running ? "running" : `stopped, exit ${target.exitCode}`})` +
    (all.filter((c) => c.running).length > 1 ? " WARNING: more than one runtime is running (pnpm agent:status)" : ""),
);
const p = spawn("docker", ["logs", "--timestamps", ...(follow ? ["-f"] : []), ...(tail ? ["--tail", tail] : []), target.id], {
  stdio: "inherit",
});
p.on("exit", (code) => process.exit(code ?? 0));
