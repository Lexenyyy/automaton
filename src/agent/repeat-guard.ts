/**
 * Repeat guard (fork, run 3).
 *
 * In the restart test the agent tried write_file SOUL.md 12 times (blocked
 * each time) and update_soul 8 times in one wake; the old pattern detector
 * compares whole-turn tool sets, so a mix of tools reset it and it only
 * warned. This guard counts per wake cycle and trips when:
 *   - the same tool fails (policy denial, "Blocked:", "ERROR:" or a tool
 *     error) maxRepeats times, any arguments; or
 *   - the same tool is called maxRepeats times with identical arguments AND
 *     an identical result (no progress).
 * The loop then forces sleep for forcedSleepMinutes and the next wake-up
 * status says why. A rerun with a different result (e.g. tests after an
 * edit) does not count as a repeat.
 */

import { createHash } from "crypto";
import type { AutomatonConfig, ToolCallResult } from "../types.js";

export interface LoopGuardSettings {
  /** Trips at this many repeats; 0 = guard off. */
  maxRepeats: number;
  /** Sleep after a forced stop (this guard and the cycle limit). */
  forcedSleepMinutes: number;
}

export const DEFAULT_LOOP_GUARD: LoopGuardSettings = { maxRepeats: 3, forcedSleepMinutes: 30 };

/** Owner settings from config.loopGuard; invalid values fall back to the defaults. */
export function resolveLoopGuard(config: Pick<AutomatonConfig, "loopGuard">): LoopGuardSettings {
  const raw = config.loopGuard ?? {};
  const maxRepeats =
    Number.isInteger(raw.maxRepeats) && (raw.maxRepeats as number) >= 0 && (raw.maxRepeats as number) <= 100
      ? (raw.maxRepeats as number)
      : DEFAULT_LOOP_GUARD.maxRepeats;
  const forcedSleepMinutes =
    typeof raw.forcedSleepMinutes === "number" && Number.isFinite(raw.forcedSleepMinutes) &&
    raw.forcedSleepMinutes >= 1 && raw.forcedSleepMinutes <= 1440
      ? raw.forcedSleepMinutes
      : DEFAULT_LOOP_GUARD.forcedSleepMinutes;
  return { maxRepeats, forcedSleepMinutes };
}

/** True when a tool call failed or was refused. */
export function isFailedToolCall(r: Pick<ToolCallResult, "result" | "error">): boolean {
  if (r.error) return true;
  const text = (r.result ?? "").trimStart();
  return /^(Blocked:|ERROR:|Error:|Policy denied)/.test(text);
}

const short = (s: string, n = 100) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

export class RepeatGuard {
  private failures = new Map<string, number>();
  private identical = new Map<string, number>();

  constructor(private readonly maxRepeats: number) {}

  /**
   * Record one executed tool call. Returns the reason when the guard trips,
   * otherwise undefined.
   */
  record(r: ToolCallResult): string | undefined {
    if (this.maxRepeats <= 0) return undefined;

    if (isFailedToolCall(r)) {
      const n = (this.failures.get(r.name) ?? 0) + 1;
      this.failures.set(r.name, n);
      if (n >= this.maxRepeats) {
        return `${r.name} failed ${n}× this wake (last: "${short(r.error ?? r.result)}")`;
      }
    }

    const key = createHash("sha256")
      .update(r.name)
      .update("\0")
      .update(JSON.stringify(r.arguments ?? {}))
      .update("\0")
      .update(r.error ?? r.result ?? "")
      .digest("hex");
    const m = (this.identical.get(key) ?? 0) + 1;
    this.identical.set(key, m);
    if (m >= this.maxRepeats) {
      return `${r.name} called ${m}× with the same arguments and the same result (no progress)`;
    }
    return undefined;
  }
}
