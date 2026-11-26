/**
 * Process supervision with a crash-loop limit (fork, Phase 2): docker/supervise-policy.mjs,
 * used by docker/supervise-agent.mjs, agent:down, agent:kill and agent:watch.
 * Owner requirements: restart after a crash, at most a few times per hour, never after an
 * owner stop (down/kill) or a lost lease; the delay outlasts the runtime lease (90 s).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error plain .mjs module without type declarations
import * as sp from "../../docker/supervise-policy.mjs";
import { LEASE_TTL_MS } from "../runtime/instance-lease.js";

const S = sp.SUPERVISE_DEFAULTS;
const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const MIN = 60_000;
const decide = (o: Record<string, unknown>) => sp.decideAfterExit({ now: NOW, settings: S, restarts: [], ...o });

describe("settings", () => {
  it("defaults: 3 restarts per 60 min, 120 s apart; the delay always outlasts the runtime lease", () => {
    expect(sp.superviseSettings({})).toEqual({ settings: { maxRestarts: 3, windowMinutes: 60, restartDelaySeconds: 120 } });
    expect(sp.MIN_RESTART_DELAY_SECONDS * 1000).toBeGreaterThan(LEASE_TTL_MS);
    expect(sp.superviseSettings({ restartDelaySeconds: "90" }).error).toMatch(/--restart-delay must be a whole number from 100/);
  });

  it("refuses non-numbers and out-of-range values", () => {
    expect(sp.superviseSettings({ maxRestarts: "x" }).error).toMatch(/--max-restarts/);
    expect(sp.superviseSettings({ maxRestarts: "21" }).error).toMatch(/--max-restarts/);
    expect(sp.superviseSettings({ windowMinutes: "0" }).error).toMatch(/--window-minutes/);
    expect(sp.superviseSettings({ maxRestarts: "0", windowMinutes: "30", restartDelaySeconds: "100" }).settings)
      .toEqual({ maxRestarts: 0, windowMinutes: 30, restartDelaySeconds: 100 });
  });
});

describe("after the runtime exits", () => {
  it("an owner stop (agent:down / agent:kill marker) is never restarted, whatever the exit code", () => {
    for (const exitCode of [0, 1, 137, null]) {
      const d = decide({ exitCode, signal: exitCode === null ? "SIGKILL" : null, stopMarker: { by: "agent:kill", at: "2026-11-26T11:59:00.000Z" } });
      expect(d.action).toBe("stop");
      expect(d.reason).toContain("stopped by the owner (agent:kill at 2026-11-26T11:59:00.000Z");
    }
  });

  it("a graceful exit (0) ends supervision; a lost lease (3) gives up at once", () => {
    expect(decide({ exitCode: 0 })).toMatchObject({ action: "stop", reason: "runtime stopped gracefully (exit 0)" });
    expect(decide({ exitCode: 3 })).toMatchObject({ action: "give_up" });
    expect(decide({ exitCode: 3 }).reason).toContain("lost its instance lease");
  });

  it("a crash restarts; the 4th crash within 60 min gives up", () => {
    expect(decide({ exitCode: 137 })).toMatchObject({ action: "restart", restartsInWindow: 0 });
    expect(decide({ exitCode: 137 }).reason).toBe("runtime crashed (exit 137); restart 1 of 3 in 60 min, in 120 s");
    expect(decide({ exitCode: 1, restarts: [NOW - 50 * MIN, NOW - 20 * MIN] })).toMatchObject({ action: "restart", restartsInWindow: 2 });
    const d = decide({ exitCode: null, signal: "SIGSEGV", restarts: [NOW - 50 * MIN, NOW - 20 * MIN, NOW - 5 * MIN] });
    expect(d).toMatchObject({ action: "give_up", restartsInWindow: 3 });
    expect(d.reason).toBe("runtime crashed (signal SIGSEGV) after 3 restart(s) in the last 60 min (limit 3)");
  });

  it("restarts older than the window no longer count", () => {
    expect(decide({ exitCode: 1, restarts: [NOW - 3 * 60 * MIN, NOW - 2 * 60 * MIN, NOW - 61 * MIN] })).toMatchObject({ action: "restart", restartsInWindow: 0 });
  });

  it("--max-restarts 0: the first crash gives up", () => {
    expect(sp.decideAfterExit({ exitCode: 1, now: NOW, restarts: [], settings: { ...S, maxRestarts: 0 } }).action).toBe("give_up");
  });
});

describe("files: stop marker and supervisor state", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "supervise-")); dirs.push(d); return d; };

  it("the marker is per project, read back, and cleared", () => {
    const dir = tmp();
    expect(sp.readStopMarker(dir, "automaton")).toBeNull();
    sp.writeStopMarker(dir, "automaton", "agent:down", new Date(NOW));
    expect(sp.readStopMarker(dir, "automaton")).toEqual({ by: "agent:down", at: "2026-11-26T12:00:00.000Z" });
    expect(sp.readStopMarker(dir, "automaton-tierwalk")).toBeNull();
    sp.clearStopMarker(dir, "automaton");
    expect(sp.readStopMarker(dir, "automaton")).toBeNull();
    sp.clearStopMarker(dir, "automaton"); // no error when already gone
  });

  it("the watchdog treats a missing runtime as a restart only for a live, fresh, waiting/running supervisor", () => {
    const dir = tmp();
    const fresh = { pid: process.pid, state: "waiting", updatedAt: new Date(NOW - 60_000).toISOString(), settings: S };
    sp.writeSupervisorState(dir, "automaton", fresh);
    const st = sp.readSupervisorState(dir, "automaton");
    expect(sp.supervisorRestarting(st, NOW, sp.pidAlive(st.pid))).toBe(true);
    expect(sp.supervisorRestarting({ ...st, state: "running" }, NOW, true)).toBe(true);
    expect(sp.supervisorRestarting(st, NOW, false)).toBe(false); // supervisor process gone
    expect(sp.supervisorRestarting({ ...st, state: "gave_up" }, NOW, true)).toBe(false);
    expect(sp.supervisorRestarting({ ...st, state: "stopped" }, NOW, true)).toBe(false);
    expect(sp.supervisorRestarting({ ...st, updatedAt: new Date(NOW - 8 * MIN).toISOString() }, NOW, true)).toBe(false); // stale (120 s + 5 min)
    expect(sp.supervisorRestarting(null, NOW, true)).toBe(false);
  });

  it("signals: Ctrl+C is an owner stop (marker); SIGTERM/SIGHUP from systemd (shutdown, reboot) is not", () => {
    expect(sp.signalWritesStopMarker("SIGINT")).toBe(true);
    expect(sp.signalWritesStopMarker("SIGTERM")).toBe(false);
    expect(sp.signalWritesStopMarker("SIGHUP")).toBe(false);
  });

  it("a state from before the last boot is not a live supervisor, even if its pid is in use again", () => {
    const boot = sp.bootAt(3600, NOW); // booted an hour ago
    expect(boot).toBe(NOW - 3_600_000);
    const st = { pid: process.pid, bootAt: boot };
    expect(sp.supervisorProcessAlive(st, sp.bootAt(3600 + 30, NOW + 30_000))).toBe(true); // same boot (rounding)
    expect(sp.supervisorProcessAlive({ ...st, bootAt: boot - 2 * 86_400_000 }, boot)).toBe(false); // previous boot
    expect(sp.supervisorProcessAlive({ pid: process.pid }, boot)).toBe(false); // no boot recorded
    expect(sp.supervisorProcessAlive(st, boot, () => false)).toBe(false); // pid gone
    expect(sp.supervisorProcessAlive(null, boot)).toBe(false);
  });

  it("pidAlive: this process yes, nonsense no", () => {
    expect(sp.pidAlive(process.pid)).toBe(true);
    expect(sp.pidAlive(0)).toBe(false);
    expect(sp.pidAlive(-5)).toBe(false);
    expect(sp.pidAlive(undefined)).toBe(false);
  });
});

describe("VPS files (docker/systemd): reboots resume the agent, owner stops do not", () => {
  const read = (f: string) => fs.readFileSync(new URL(`../../docker/systemd/${f}`, import.meta.url), "utf8");
  const directives = (text: string) =>
    Object.fromEntries(text.split("\n").filter((l) => /^[A-Za-z]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

  it("agent unit: starts the supervisor at boot after Docker, without --resume (an owner stop stays stopped)", () => {
    const u = directives(read("automaton-agent.service"));
    expect(u.ExecStart).toBe("/usr/bin/node docker/supervise-agent.mjs");
    expect(u.Requires).toBe("docker.service");
    expect(u.After).toContain("docker.service");
    expect(u.WantedBy).toBe("multi-user.target");
    expect(u.User).toBe("automaton"); // not root
  });

  it("agent unit: SIGTERM to the supervisor only, enough time for a graceful stop; exits 0 and 2 are final", () => {
    const u = directives(read("automaton-agent.service"));
    expect(u.KillMode).toBe("mixed");
    expect(u.KillSignal).toBe("SIGTERM");
    expect(sp.signalWritesStopMarker(u.KillSignal)).toBe(false); // a reboot is a system stop: no marker
    expect(Number(u.TimeoutStopSec)).toBeGreaterThanOrEqual(120); // agent:down waits up to 30 s + removal
    expect(u.Restart).toBe("on-abnormal"); // never after exit 0 (stopped) or 2 (gave up)
    expect(Number(u.RestartSec) * 1000).toBeGreaterThan(LEASE_TTL_MS);
  });

  it("watch unit: keeps the run's end across reboots (--until); a tripped stop rule (exit 2) is final", () => {
    const u = directives(read("automaton-watch.service"));
    expect(u.ExecStart).toContain("--until ${AUTOMATON_WATCH_UNTIL}");
    expect(u.ExecStart).toContain("--since ${AUTOMATON_WATCH_SINCE}");
    expect(u.ExecStart).not.toContain("--hours");
    expect(u.Restart).toBe("on-failure");
    expect(u.RestartPreventExitStatus).toBe("2");
    expect(u.After).toContain("automaton-agent.service");
  });

  it("unattended upgrades: reboot when needed, at a fixed time", () => {
    const apt = read("52automaton-unattended-reboot");
    expect(apt).toContain('Unattended-Upgrade::Automatic-Reboot "true";');
    expect(apt).toMatch(/Unattended-Upgrade::Automatic-Reboot-Time "\d{2}:\d{2}";/);
  });

  it("env example: no secret values, secrets readable by the runtime's group only", () => {
    const env = read("automaton.env.example");
    expect(env).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(env).toContain("-g 10001 -m 750");
    expect(env).toContain("-g 10001 -m 640");
  });
});
