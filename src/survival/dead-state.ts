/**
 * The run loop while the agent is dead (fork, Phase 4 step 3; finding F1).
 *
 * Upstream re-entered the agent loop every 5 minutes while dead, and the agent
 * loop overwrote "dead" and called the model. Now the run loop waits here
 * instead: no agent loop, no model call. Only the heartbeat's survival watch
 * (tier-watch.ts) leaves dead, when the balance is above $0 again; then this
 * returns and the run loop resumes normally. Wake events that arrive while
 * dead are consumed and ignored.
 */

import type BetterSqlite3 from "better-sqlite3";
import { consumeNextWakeEvent } from "../state/database.js";
import { getAgentStateRaw } from "./tier-watch.js";

type Database = BetterSqlite3.Database;

export const DEAD_POLL_MS = 30_000;

export async function waitWhileDead(
  db: Database,
  deps: { sleep?: (ms: number) => Promise<void>; pollMs?: number } = {},
): Promise<{ polls: number; ignoredWakes: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? DEAD_POLL_MS;
  let polls = 0;
  let ignoredWakes = 0;
  while (getAgentStateRaw(db) === "dead") {
    await sleep(pollMs);
    polls++;
    // Drop wake requests only while still dead; the revival wake (tier change
    // out of dead) stays queued for the agent loop.
    if (getAgentStateRaw(db) === "dead") while (consumeNextWakeEvent(db)) ignoredWakes++;
  }
  return { polls, ignoredWakes };
}
