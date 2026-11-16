/**
 * Fork, Phase 1: runtime instance lease (one agent loop per state.db).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "./mocks.js";
import {
  LEASE_KEY,
  LEASE_REFRESH_MS,
  LEASE_TTL_MS,
  acquireRuntimeLease,
  formatLeaseRefusal,
  readRuntimeLease,
  refreshRuntimeLease,
  releaseRuntimeLease,
  startLeaseHeartbeat,
} from "../runtime/instance-lease.js";

const T0 = Date.parse("2026-11-16T15:35:08.000Z");
const A = { host: "runtime-a", pid: 1, build: "aaa" };
const B = { host: "runtime-b", pid: 1, build: "bbb" };

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("runtime instance lease", () => {
  it("a second runtime is refused while the first one's heartbeat is fresh", () => {
    const a = acquireRuntimeLease(db.raw, A, T0);
    expect(a.ok).toBe(true);
    const b = acquireRuntimeLease(db.raw, B, T0 + LEASE_TTL_MS - 1);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.holder.host).toBe("runtime-a");
    const msg = formatLeaseRefusal(b.holder, b.ageMs);
    expect(msg).toContain("host runtime-a, pid 1, build aaa");
    expect(msg).toContain("last heartbeat 90 s ago");
    expect(msg).toContain("Refusing to start");
  });

  it("renewing keeps it; a lease without heartbeat for the TTL can be taken over", () => {
    const a = acquireRuntimeLease(db.raw, A, T0);
    if (!a.ok) throw new Error("not acquired");
    expect(refreshRuntimeLease(db.raw, a.lease.instanceId, T0 + 60_000)).toBe(true);
    expect(acquireRuntimeLease(db.raw, B, T0 + 60_000 + LEASE_TTL_MS - 1).ok).toBe(false);

    const b = acquireRuntimeLease(db.raw, B, T0 + 60_000 + LEASE_TTL_MS);
    expect(b.ok).toBe(true);
    // The old holder finds out on its next renewal and must stop.
    expect(refreshRuntimeLease(db.raw, a.lease.instanceId, T0 + 200_000)).toBe(false);
    expect(readRuntimeLease(db.raw, T0 + 200_000)?.lease.host).toBe("runtime-b");
  });

  it("release frees it at once, but never removes another holder's lease", () => {
    const a = acquireRuntimeLease(db.raw, A, T0);
    if (!a.ok) throw new Error("not acquired");
    releaseRuntimeLease(db.raw, "someone-else");
    expect(readRuntimeLease(db.raw, T0)?.live).toBe(true);
    releaseRuntimeLease(db.raw, a.lease.instanceId);
    expect(readRuntimeLease(db.raw, T0)).toBeNull();
    expect(acquireRuntimeLease(db.raw, B, T0 + 1).ok).toBe(true);
  });

  it("a malformed lease value counts as free", () => {
    db.setKV(LEASE_KEY, "not json");
    expect(acquireRuntimeLease(db.raw, A, T0).ok).toBe(true);
  });

  it("the heartbeat renews the lease and reports a takeover once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const a = acquireRuntimeLease(db.raw, A);
    if (!a.ok) throw new Error("not acquired");
    const lost: string[] = [];
    const stop = startLeaseHeartbeat(db.raw, a.lease.instanceId, (why) => lost.push(why));

    vi.advanceTimersByTime(LEASE_REFRESH_MS);
    expect(new Date(readRuntimeLease(db.raw)!.lease.heartbeatAt).getTime()).toBe(T0 + LEASE_REFRESH_MS);
    expect(lost).toEqual([]);

    // Another runtime takes over (simulated by removing ours and acquiring).
    releaseRuntimeLease(db.raw, a.lease.instanceId);
    expect(acquireRuntimeLease(db.raw, B).ok).toBe(true);
    vi.advanceTimersByTime(LEASE_REFRESH_MS * 3);
    expect(lost).toEqual(["another runtime took over the lease"]);
    expect(readRuntimeLease(db.raw)!.lease.host).toBe("runtime-b");
    stop();
  });
});
