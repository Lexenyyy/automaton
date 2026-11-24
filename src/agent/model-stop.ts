/**
 * Fork (after the tier walk's gpt-4.1-nano 404): the "model unavailable" stop.
 *
 * When a model call answers "model not found", the agent loop records it here
 * (kv `model_unavailable`: model, provider, code, since) and ends the wake. From
 * then on the run loop waits in waitWhileModelUnavailable: no agent loop, no
 * model call, wake requests (heartbeat, tier changes) consumed and ignored. Only
 * a restart of the runtime clears it (owner decision 2026-11-24: only the owner
 * can fix the config, so no retry every 30 minutes). agent:status shows it as
 * the first line; the watchdog reports it and stops the agent.
 */

import type BetterSqlite3 from "better-sqlite3";
import { consumeNextWakeEvent } from "../state/database.js";
import type { ModelUnavailableError } from "../inference/model-unavailable.js";

type Database = BetterSqlite3.Database;

export const MODEL_STOP_KEY = "model_unavailable";
export const MODEL_STOP_POLL_MS = 30_000;

export interface ModelStopRecord {
  model: string;
  provider: string;
  code: string;
  since: string;
}

function getKV(db: Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function recordModelUnavailable(db: Database, err: Pick<ModelUnavailableError, "model" | "provider" | "code">, now = new Date()): ModelStopRecord {
  const rec: ModelStopRecord = { model: err.model, provider: err.provider, code: err.code, since: now.toISOString() };
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(MODEL_STOP_KEY, JSON.stringify(rec));
  return rec;
}

export function readModelUnavailable(db: Database): ModelStopRecord | null {
  try {
    const v = JSON.parse(getKV(db, MODEL_STOP_KEY) ?? "null");
    return v && typeof v.model === "string" && typeof v.since === "string" ? (v as ModelStopRecord) : null;
  } catch {
    return null;
  }
}

/** Runtime start (`--run`): a restart is the owner's action, so it clears the stop. Returns what was cleared. */
export function clearModelUnavailableOnStart(db: Database): ModelStopRecord | null {
  const rec = readModelUnavailable(db);
  db.prepare("DELETE FROM kv WHERE key = ?").run(MODEL_STOP_KEY);
  return rec;
}

const utc = (iso: string) => iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");

/** The owner notice (agent:status first line, watchdog). No secrets: model and provider names only. */
export function formatModelStop(rec: ModelStopRecord): string {
  return (
    `MODEL UNAVAILABLE since ${utc(rec.since)}: ${rec.model} (${rec.provider}: ${rec.code}). ` +
    "The agent stays asleep until the runtime is restarted (no retries, no model calls). " +
    "Fix the model in the config (modelStrategy, agentSettings.model.allowedModels), run preflight, then restart."
  );
}

/** The run loop's wait: returns only when the stop is cleared (in practice: never, until restart). */
export async function waitWhileModelUnavailable(
  db: Database,
  deps: { sleep?: (ms: number) => Promise<void>; pollMs?: number } = {},
): Promise<{ polls: number; ignoredWakes: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? MODEL_STOP_POLL_MS;
  let polls = 0;
  let ignoredWakes = 0;
  while (readModelUnavailable(db)) {
    while (consumeNextWakeEvent(db)) ignoredWakes++;
    await sleep(pollMs);
    polls++;
  }
  return { polls, ignoredWakes };
}
