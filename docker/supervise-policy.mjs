/**
 * Supervision rules (fork, Phase 2: process supervision with a crash-loop limit).
 * Pure functions and small file helpers, shared by supervise-agent.mjs,
 * down-agent.mjs, kill-agent.mjs and watch-agent.mjs; unit-tested in
 * src/__tests__/supervise-policy.test.ts.
 *
 * After the runtime exits, the supervisor:
 *   - stops supervising when the owner stopped it (stop marker written by
 *     agent:down / agent:kill, or exit 0 = graceful stop), or when the runtime
 *     lost its instance lease (exit 3: another runtime holds the database);
 *   - otherwise counts a crash and restarts after restartDelaySeconds, unless
 *     that would be more than maxRestarts restarts within windowMinutes: then it
 *     gives up and leaves the agent stopped.
 * The delay must exceed the runtime lease TTL (90 s), or the new runtime would
 * be refused while the crashed one's lease is still fresh.
 */

import fs from "node:fs";
import path from "node:path";

export const SUPERVISE_DEFAULTS = Object.freeze({ maxRestarts: 3, windowMinutes: 60, restartDelaySeconds: 120 });
/** Runtime lease TTL is 90 s (src/runtime/instance-lease.ts); the delay must be longer. */
export const MIN_RESTART_DELAY_SECONDS = 100;
export const LEASE_LOST_EXIT = 3;

/** Settings from CLI values (strings or undefined). Returns { settings } or { error }. */
export function superviseSettings(raw = {}) {
  const pick = (name, value, def, min, max) => {
    if (value === undefined) return def;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  try {
    return {
      settings: {
        maxRestarts: pick("--max-restarts", raw.maxRestarts, SUPERVISE_DEFAULTS.maxRestarts, 0, 20),
        windowMinutes: pick("--window-minutes", raw.windowMinutes, SUPERVISE_DEFAULTS.windowMinutes, 1, 1440),
        restartDelaySeconds: pick(
          "--restart-delay",
          raw.restartDelaySeconds,
          SUPERVISE_DEFAULTS.restartDelaySeconds,
          MIN_RESTART_DELAY_SECONDS,
          3600,
        ),
      },
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * What to do after the runtime exited.
 *   exitCode: number or null (killed by a signal); stopMarker: object or null;
 *   restarts: times (ms) of earlier restarts; now: ms.
 * Returns { action: "stop" | "restart" | "give_up", reason, restartsInWindow }.
 */
export function decideAfterExit({ exitCode, signal = null, stopMarker = null, restarts = [], now, settings }) {
  const windowMs = settings.windowMinutes * 60_000;
  const inWindow = restarts.filter((t) => now - t < windowMs).length;
  const how = exitCode === null || exitCode === undefined ? `signal ${signal ?? "?"}` : `exit ${exitCode}`;
  if (stopMarker) {
    return { action: "stop", reason: `stopped by the owner (${stopMarker.by ?? "stop marker"} at ${stopMarker.at ?? "?"}; runtime ${how})`, restartsInWindow: inWindow };
  }
  if (exitCode === 0) return { action: "stop", reason: "runtime stopped gracefully (exit 0)", restartsInWindow: inWindow };
  if (exitCode === LEASE_LOST_EXIT) {
    return { action: "give_up", reason: "runtime lost its instance lease (exit 3): another runtime uses this database", restartsInWindow: inWindow };
  }
  if (inWindow >= settings.maxRestarts) {
    return {
      action: "give_up",
      reason: `runtime crashed (${how}) after ${inWindow} restart(s) in the last ${settings.windowMinutes} min (limit ${settings.maxRestarts})`,
      restartsInWindow: inWindow,
    };
  }
  return {
    action: "restart",
    reason: `runtime crashed (${how}); restart ${inWindow + 1} of ${settings.maxRestarts} in ${settings.windowMinutes} min, in ${settings.restartDelaySeconds} s`,
    restartsInWindow: inWindow,
  };
}

// ─── files in the log folder (outside the repo) ─────────────────

export const stopMarkerFile = (dir, project) => path.join(dir, `stop-${project}.json`);
export const supervisorStateFile = (dir, project) => path.join(dir, `supervise-${project}.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** agent:down / agent:kill: tell a supervisor not to restart the runtime they stop. */
export function writeStopMarker(dir, project, by, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stopMarkerFile(dir, project), JSON.stringify({ by, at: now.toISOString() }));
}
export const readStopMarker = (dir, project) => readJson(stopMarkerFile(dir, project));
export function clearStopMarker(dir, project) {
  fs.rmSync(stopMarkerFile(dir, project), { force: true });
}

export function writeSupervisorState(dir, project, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(supervisorStateFile(dir, project), JSON.stringify(state));
}
export const readSupervisorState = (dir, project) => readJson(supervisorStateFile(dir, project));

/**
 * Watchdog: is a supervisor about to (re)start the runtime? True when its state
 * is "waiting" (a restart is scheduled) or "running" (the runtime is starting),
 * its process is alive, and the state is fresh (written within the restart delay
 * plus 5 minutes). Anything else: the missing runtime is a stop.
 */
export function supervisorRestarting(state, now, pidAlive) {
  if (!state || !["waiting", "running"].includes(state.state) || !pidAlive) return false;
  const freshMs = ((state.settings?.restartDelaySeconds ?? SUPERVISE_DEFAULTS.restartDelaySeconds) + 300) * 1000;
  return now - Date.parse(state.updatedAt ?? "") < freshMs;
}

/** process.kill(pid, 0): true if the process exists (EPERM = exists, owned by someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
