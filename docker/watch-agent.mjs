#!/usr/bin/env node
/**
 * pnpm agent:watch (fork, Phase 2 prep): watchdog for unattended runs.
 *
 *   node docker/watch-agent.mjs [--project <name>] [--hours <h>] [--interval <s>]
 *        [--max-run-cents <c>] [--max-hour-cents <c>] [--max-wake-turns <n>]
 *        [--max-hour-turns <n>] [--max-denials <n>] [--since <ISO time>] [--once]
 *
 * Every --interval seconds (default 300) it checks Docker (agent:status logic)
 * and the activity report from state.db (`runtime --activity --json --since
 * <watch start>`: a no-network one-off, no model call). On the first stop
 * rule that trips it runs `agent:down` (graceful; logs saved) and exits 2.
 * After --hours it stops the agent the same way and exits 0 (run complete).
 * Every check is one line on the console and in
 * ~/.automaton-logs/watch-<project>-<start>.log (AUTOMATON_LOG_DIR).
 *
 * Stop rules (defaults sit below the code caps, so the watchdog acts first):
 *   - no runtime running (exited or stopped), more than one, or an OLD IMAGE
 *   - inference spend since the watch started  > --max-run-cents  (default 5)
 *   - inference spend in the last hour         > --max-hour-cents (default 3)
 *   - turns in one wake (started after the watch) > --max-wake-turns (default 6)
 *   - turns in the last hour                   > --max-hour-turns (default 20)
 *   - a wake ended by force: loop guard, cycle limit, budget cap, wake limit,
 *     consecutive errors
 *   - one tool denied by policy --max-denials times (default 3)
 *   - survival tier low_compute, critical or dead
 *   - any ledger entry other than inference cost (grants, transfers, revenue)
 *   - the activity report unreadable 3 checks in a row
 * Stopping the watchdog (Ctrl+C) does not stop the agent.
 * --once: check once and exit (0 ok, 2 tripped; agent:down still runs on a trip).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT, isValidProject, logDir, runActivity, runningRuntimes } from "./agent-instances.mjs";

const WHO = "agent:watch";
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name, def, min = 0) => {
  const v = opt(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    console.error(`${WHO}: ${name} must be a number >= ${min}`);
    process.exit(2);
  }
  return n;
};

const project = opt("--project") ?? DEFAULT_PROJECT;
if (!isValidProject(project)) {
  console.error(`${WHO}: invalid --project name`);
  process.exit(2);
}
const limits = {
  hours: opt("--hours") === undefined ? null : num("--hours", 0, 0.0001),
  intervalS: num("--interval", 300, 10),
  maxRunCents: num("--max-run-cents", 5),
  maxHourCents: num("--max-hour-cents", 3),
  maxWakeTurns: num("--max-wake-turns", 6, 1),
  maxHourTurns: num("--max-hour-turns", 20, 1),
  maxDenials: num("--max-denials", 3, 1),
};
const once = args.includes("--once");

// --since: count from an earlier time, e.g. when restarting the watchdog for a
// run already in progress. Default: now. --hours always counts from now.
const sinceOpt = opt("--since");
if (sinceOpt !== undefined && !Number.isFinite(Date.parse(sinceOpt))) {
  console.error(`${WHO}: --since must be an ISO time, e.g. 2026-11-16T20:00:00Z`);
  process.exit(2);
}
const started = new Date();
const startIso = sinceOpt ? new Date(sinceOpt).toISOString() : started.toISOString();
const countFrom = new Date(startIso).getTime();
fs.mkdirSync(logDir(), { recursive: true });
const logFile = path.join(logDir(), `watch-${project}-${started.toISOString().replace(/[:.]/g, "-")}.log`);
const out = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  fs.appendFileSync(logFile, `${text}\n`);
};
const cents = (mc) => (mc / 1000).toFixed(3);

function stopAgent(why, code) {
  out(`${code === 0 ? "DONE" : "STOP"}: ${why}. Running agent:down ...`);
  const down = path.join(path.dirname(fileURLToPath(import.meta.url)), "down-agent.mjs");
  const r = spawnSync(process.execPath, [down, "--project", project], { encoding: "utf-8", timeout: 240_000 });
  for (const l of `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")) if (l) out(`  ${l}`);
  out(`agent:down exit ${r.status}. Watch log: ${logFile}`);
  process.exit(code);
}

let activityFailures = 0;

/** One check. Returns a reason to stop, or null. */
function check() {
  const runtimes = runningRuntimes(project, WHO);
  if (runtimes.length === 0) return "no runtime is running (it exited or was stopped)";
  if (runtimes.length > 1) return `${runtimes.length} runtimes are running: ${runtimes.map((c) => c.name).join(", ")}`;
  if (runtimes[0].stale) return `${runtimes[0].name} runs an OLD IMAGE (build ${runtimes[0].commit})`;

  const r = runActivity(project, ["--json", "--since", startIso]);
  let a;
  try {
    a = r.code === 0 ? JSON.parse(r.out.split("\n").pop()) : null;
  } catch {
    a = null;
  }
  if (!a?.since) {
    activityFailures++;
    out(`warning: activity report unreadable (${activityFailures}/3): ${r.err.split("\n").pop() || `exit ${r.code}`}`);
    return activityFailures >= 3 ? "activity report unreadable 3 checks in a row" : null;
  }
  activityFailures = 0;

  const s = a.since;
  const withinFirstHour = Date.now() - countFrom < 3_600_000;
  // In the first hour, count only what happened since the watch started.
  const hourSpendMc = withinFirstHour ? s.spendMc : a.spendLastHourMc;
  const hourTurns = withinFirstHour ? s.turns : a.turnsLastHour;
  const wakeEnd = (() => {
    try {
      return a.lastWakeEnd ? JSON.parse(a.lastWakeEnd) : null;
    } catch {
      return null;
    }
  })();

  out(
    `check: ${runtimes[0].name} build ${runtimes[0].commit} | state ${a.agentState}, tier ${a.tier ?? "?"} | ` +
      `since start: ${s.turns} turns, ${cents(s.spendMc)}c | last hour: ${hourTurns} turns, ${cents(hourSpendMc)}c | ` +
      `this wake: ${a.turnsThisWake} turns | last wake end: ${wakeEnd?.reason ?? "-"}`,
  );

  if (s.spendMc > limits.maxRunCents * 1000) return `inference spend since start ${cents(s.spendMc)}c > ${limits.maxRunCents}c`;
  if (hourSpendMc > limits.maxHourCents * 1000) return `inference spend in the last hour ${cents(hourSpendMc)}c > ${limits.maxHourCents}c`;
  if (a.wakeStartedAt && a.wakeStartedAt >= startIso && a.turnsThisWake > limits.maxWakeTurns) {
    return `${a.turnsThisWake} turns in one wake > ${limits.maxWakeTurns}`;
  }
  if (hourTurns > limits.maxHourTurns) return `${hourTurns} turns in the last hour > ${limits.maxHourTurns}`;
  if (wakeEnd?.at >= startIso && /^(forced sleep|cycle limit|budget cap|wake limit|\d+ consecutive errors)/.test(wakeEnd.reason ?? "")) {
    return `a wake ended by force: ${wakeEnd.reason}`;
  }
  if (s.maxDenials && s.maxDenials.count >= limits.maxDenials) {
    return `${s.maxDenials.tool} denied by policy ${s.maxDenials.count} times`;
  }
  if (["low_compute", "critical", "dead"].includes(a.tier) || a.agentState === "dead") {
    return `survival tier ${a.tier}, state ${a.agentState}`;
  }
  if (s.otherLedgerEntries > 0) return `${s.otherLedgerEntries} ledger entr${s.otherLedgerEntries === 1 ? "y" : "ies"} other than inference cost`;
  return null;
}

out(
  `${WHO}: watching project "${project}" ${limits.hours ? `for ${limits.hours} h` : "until stopped"}, every ${limits.intervalS} s. ` +
    `Limits: run ${limits.maxRunCents}c, hour ${limits.maxHourCents}c, ${limits.maxWakeTurns} turns/wake, ` +
    `${limits.maxHourTurns} turns/hour, ${limits.maxDenials} denials/tool; counting from ${startIso}. Log: ${logFile}`,
);
if (runningRuntimes(project, WHO).length === 0) {
  out(`${WHO}: no runtime of project "${project}" is running; nothing to watch. Start it first (pnpm agent:run --detach).`);
  process.exit(1);
}
process.on("SIGINT", () => {
  out(`${WHO}: watchdog stopped (Ctrl+C). The agent is still running; stop it with pnpm agent:down.`);
  process.exit(130);
});

for (;;) {
  const why = check();
  if (why) stopAgent(why, 2);
  if (once) {
    out(`${WHO}: --once: all checks passed.`);
    process.exit(0);
  }
  if (limits.hours && Date.now() - started.getTime() >= limits.hours * 3_600_000) {
    stopAgent(`run complete after ${limits.hours} h`, 0);
  }
  const untilEnd = limits.hours ? started.getTime() + limits.hours * 3_600_000 - Date.now() : Infinity;
  await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(limits.intervalS * 1000, untilEnd))));
}
