/**
 * In-flight model calls and graceful shutdown (fork, Phase 1).
 *
 * Every paid or free model call goes through InferenceBudgetTracker.tryReserve
 * and releases its reservation after its cost is recorded (or the call failed).
 * This module counts those calls process-wide, so a SIGTERM shutdown can wait
 * until every call that already ran has reached inference_costs and the
 * ledger. Exiting earlier could leave a call billed by the provider but never
 * recorded (the ledger would show less than the real cost).
 *
 * After beginShutdown(), no new call is admitted.
 */

let inFlight = 0;
let shuttingDown = false;
const waiters = new Set<() => void>();

/** Called by tryReserve when a call is admitted; the returned function ends it (idempotent). */
export function trackInferenceCall(): () => void {
  inFlight++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      for (const w of [...waiters]) w();
    }
  };
}

export function getInFlightInferenceCount(): number {
  return inFlight;
}

/** From now on no new model call is admitted (tryReserve refuses). */
export function beginInferenceShutdown(): void {
  shuttingDown = true;
}

export function isInferenceShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Resolves true when no call is in flight, or false after timeoutMs with
 * calls still running.
 */
export function waitForInFlightInference(timeoutMs: number): Promise<boolean> {
  if (inFlight === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      waiters.delete(onIdle);
      resolve(ok);
    };
    const onIdle = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    waiters.add(onIdle);
  });
}

/** Tests only. */
export function resetInFlightInferenceForTests(): void {
  inFlight = 0;
  shuttingDown = false;
  waiters.clear();
}
