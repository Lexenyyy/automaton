#!/usr/bin/env node
/**
 * pnpm agent:status (fork, Phase 1): is an agent running, and what is it doing?
 *
 *   node docker/status-agent.mjs [--project <name>] [--no-activity]
 *
 * 1. Lists the project's running runtime containers (pnpm agent:run ones
 *    included, from any terminal) and the sandbox, with uptime.
 * 2. Prints the activity report from state.db (`runtime --activity`, a short
 *    one-off without the sandbox): state, last turn, turns and inference spend
 *    in the last hour and today, sleep and budget pause. Read-only, no model call.
 * Changes nothing. Exit 0, or 1 if Docker cannot be reached.
 */

import {
  DEFAULT_PROJECT,
  describeContainer,
  isValidProject,
  runActivity,
  runningContainers,
  runningRuntimes,
} from "./agent-instances.mjs";

const WHO = "agent:status";
const args = process.argv.slice(2);
const pi = args.indexOf("--project");
const project = pi >= 0 ? args[pi + 1] : DEFAULT_PROJECT;
if (!isValidProject(project)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}

const runtimes = runningRuntimes(project, WHO);
const sandboxes = runningContainers(project, "sandbox", WHO);

console.log(`${WHO}: project "${project}"`);
if (runtimes.length === 0) {
  console.log("Runtime:  not running (no agent).");
} else {
  console.log(`Runtime:  RUNNING, ${runtimes.length} container(s)${runtimes.length > 1 ? " (more than one agent!)" : ""}:`);
  for (const c of runtimes) console.log(`  ${describeContainer(c)}`);
  console.log("  Stop: pnpm agent:down (graceful) or pnpm agent:kill (immediate).");
}
console.log(
  sandboxes.length === 0
    ? "Sandbox:  not running."
    : `Sandbox:  running: ${sandboxes.map((c) => describeContainer(c)).join(", ")}`,
);

if (!args.includes("--no-activity")) {
  const r = runActivity(project);
  if (r.code === 0 && r.out) {
    console.log(`\n${r.out}`);
  } else {
    console.error(`\n${WHO}: activity report unavailable (${r.err.split("\n").pop() || `exit ${r.code}`}).`);
  }
}
process.exit(0);
