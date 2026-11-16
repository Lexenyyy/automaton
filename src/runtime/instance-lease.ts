/**
 * Runtime instance lease (fork, Phase 1): at most one agent loop per state.db.
 *
 * Incident 2026-11-16: a second `agent:run` ran unnoticed next to the owner's
 * checks. The Docker scripts now refuse a second runtime; this is the backstop
 * in code, independent of how the runtime was started (e.g. a direct
 * `docker compose run`).
 *
 * `--run` takes the lease (kv `runtime_lease`) in an IMMEDIATE transaction
 * right after the database opens, before anything else is written, and renews
 * it every LEASE_REFRESH_MS. A second runtime refuses to start while another
 * holder's heartbeat is younger than LEASE_TTL_MS. A holder that finds the
 * lease taken over (it stalled longer than the TTL) must stop. Graceful
 * shutdown releases it; after a kill (SIGKILL) it expires after the TTL.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export const LEASE_KEY = "runtime_lease";
export const LEASE_TTL_MS = 90_000;
export const LEASE_REFRESH_MS = 30_000;

export interface RuntimeLease {
  instanceId: string;
  /** Container ID (Docker hostname) or host name. */
  host: string;
  pid: number;
  build: string;
  startedAt: string;
  heartbeatAt: string;
}

export type AcquireResult =
  | { ok: true; lease: RuntimeLease }
  | { ok: false; holder: RuntimeLease; ageMs: number };

function readRaw(db: Database): RuntimeLease | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEASE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as RuntimeLease;
    return typeof v?.instanceId === "string" && typeof v?.heartbeatAt === "string" ? v : null;
  } catch {
    return null; // malformed: treated as free
  }
}

function write(db: Database, lease: RuntimeLease): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(LEASE_KEY, JSON.stringify(lease));
}

/** Age of the holder's last heartbeat. Unparseable = expired. A future time counts as live. */
function ageMs(lease: RuntimeLease, now: number): number {
  const t = new Date(lease.heartbeatAt).getTime();
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

export function readRuntimeLease(db: Database, now: number = Date.now()): { lease: RuntimeLease; ageMs: number; live: boolean } | null {
  const lease = readRaw(db);
  if (!lease) return null;
  const age = ageMs(lease, now);
  return { lease, ageMs: age, live: age < LEASE_TTL_MS };
}

export function acquireRuntimeLease(
  db: Database,
  me: { host: string; pid: number; build: string },
  now: number = Date.now(),
): AcquireResult {
  return db
    .transaction((): AcquireResult => {
      const holder = readRaw(db);
      if (holder) {
        const age = ageMs(holder, now);
        if (age < LEASE_TTL_MS) return { ok: false, holder, ageMs: age };
      }
      const iso = new Date(now).toISOString();
      const lease: RuntimeLease = { instanceId: randomUUID(), ...me, startedAt: iso, heartbeatAt: iso };
      write(db, lease);
      return { ok: true, lease };
    })
    .immediate();
}

/** Renew our lease. false = it is no longer ours (taken over or removed): stop. */
export function refreshRuntimeLease(db: Database, instanceId: string, now: number = Date.now()): boolean {
  return db
    .transaction((): boolean => {
      const holder = readRaw(db);
      if (!holder || holder.instanceId !== instanceId) return false;
      write(db, { ...holder, heartbeatAt: new Date(now).toISOString() });
      return true;
    })
    .immediate();
}

/** Remove the lease if it is still ours (never someone else's). */
export function releaseRuntimeLease(db: Database, instanceId: string): void {
  db.transaction(() => {
    const holder = readRaw(db);
    if (holder?.instanceId === instanceId) db.prepare("DELETE FROM kv WHERE key = ?").run(LEASE_KEY);
  }).immediate();
}

/**
 * Renew every LEASE_REFRESH_MS; calls onLost once if the lease is no longer
 * ours or cannot be renewed. Returns a stop function.
 */
export function startLeaseHeartbeat(db: Database, instanceId: string, onLost: (why: string) => void): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    let why: string | null = null;
    try {
      if (!refreshRuntimeLease(db, instanceId)) why = "another runtime took over the lease";
    } catch (err: any) {
      why = `lease renewal failed: ${err?.message ?? String(err)}`;
    }
    if (why) {
      stopped = true;
      clearInterval(timer);
      onLost(why);
    }
  }, LEASE_REFRESH_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function formatLeaseHolder(holder: RuntimeLease, age: number): string {
  const ago = Number.isFinite(age) ? `${Math.max(0, Math.round(age / 1000))} s ago` : "unknown";
  return `host ${holder.host}, pid ${holder.pid}, build ${holder.build}, started ${holder.startedAt}, last heartbeat ${ago}`;
}

export function formatLeaseRefusal(holder: RuntimeLease, age: number): string {
  return (
    `Another runtime is already running on this database (${formatLeaseHolder(holder, age)}). ` +
    "Only one agent may run at a time. Stop it first (pnpm agent:down; pnpm agent:status shows it). " +
    `If it was killed, its lease expires ${LEASE_TTL_MS / 1000} s after its last heartbeat. Refusing to start.`
  );
}
