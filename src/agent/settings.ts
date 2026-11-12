/**
 * Agent-changeable settings (fork, Phase 1).
 *
 * The agent may change two settings itself: its genesis prompt and its active
 * inference model. The config file is read-only (Docker), so changes are
 * stored in the database (agent_settings) and applied in memory. The owner
 * sets the limits in the config (agentSettings), which the agent cannot
 * change:
 *
 *   genesis prompt  off by default; max changes per UTC day; max length
 *   model           only allowedModels (default: the three models in the
 *                   owner's modelStrategy); max changes per UTC day
 *
 * The effective value is the owner's config value, replaced by the agent's
 * stored value only while that value still meets the owner's CURRENT limits.
 * Budget caps (daily, lifetime) apply to every model regardless.
 *
 * Owner commands (run from the host, the agent has no access):
 *   automaton --settings show | reset
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";

type Database = BetterSqlite3.Database;

export type AgentSettingKey = "genesis_prompt" | "inference_model";

export interface ResolvedSettingsLimits {
  genesisPrompt: { allowAgentChanges: boolean; maxChangesPerDay: number; maxLength: number };
  model: { allowAgentChanges: boolean; allowedModels: string[]; maxChangesPerDay: number };
}

interface OwnerBaseline {
  genesisPrompt: string;
  inferenceModel: string;
  strategyModels: string[];
}

export type SettingResult = { ok: true; message: string } | { ok: false; error: string };

export const DEFAULT_GENESIS_MAX_LENGTH = 2000;

// The owner's values as loaded from the config, before any agent change.
// Kept per config object so in-memory agent changes never widen the limits.
const baselines = new WeakMap<AutomatonConfig, OwnerBaseline>();

function captureBaseline(config: AutomatonConfig): OwnerBaseline {
  let baseline = baselines.get(config);
  if (!baseline) {
    const s = config.modelStrategy;
    baseline = {
      genesisPrompt: config.genesisPrompt ?? "",
      inferenceModel: s?.inferenceModel ?? config.inferenceModel,
      strategyModels: [s?.inferenceModel ?? config.inferenceModel, s?.lowComputeModel, s?.criticalModel].filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      ),
    };
    baselines.set(config, Object.freeze(baseline));
  }
  return baseline;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function resolveSettingsLimits(config: AutomatonConfig): ResolvedSettingsLimits {
  const baseline = captureBaseline(config);
  const g = config.agentSettings?.genesisPrompt ?? {};
  const m = config.agentSettings?.model ?? {};
  const allowedModels = Array.isArray(m.allowedModels)
    ? m.allowedModels.filter((x): x is string => typeof x === "string" && x.length > 0)
    : baseline.strategyModels;
  return {
    genesisPrompt: {
      allowAgentChanges: g.allowAgentChanges === true,
      maxChangesPerDay: nonNegativeInt(g.maxChangesPerDay, 1),
      maxLength: Math.min(nonNegativeInt(g.maxLength, DEFAULT_GENESIS_MAX_LENGTH), DEFAULT_GENESIS_MAX_LENGTH),
    },
    model: {
      allowAgentChanges: m.allowAgentChanges !== false,
      allowedModels: [...new Set(allowedModels)],
      maxChangesPerDay: nonNegativeInt(m.maxChangesPerDay, 4),
    },
  };
}

function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function agentChangesToday(db: Database, key: AgentSettingKey, now: Date): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM agent_settings_changes WHERE key = ? AND actor = 'agent' AND changed_at >= ?")
    .get(key, utcDayStart(now)) as { n: number };
  return row.n;
}

function readStored(db: Database, key: AgentSettingKey): { value: string; reason: string; updated_at: string } | undefined {
  return db.prepare("SELECT value, reason, updated_at FROM agent_settings WHERE key = ?").get(key) as
    | { value: string; reason: string; updated_at: string }
    | undefined;
}

function store(db: Database, key: AgentSettingKey, value: string, reason: string, now: Date): void {
  const ts = now.toISOString();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO agent_settings (key, value, reason, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, reason = excluded.reason, updated_at = excluded.updated_at",
    ).run(key, value, reason, ts);
    db.prepare("INSERT INTO agent_settings_changes (key, actor, value, reason, changed_at) VALUES (?, 'agent', ?, ?, ?)").run(
      key,
      value,
      reason,
      ts,
    );
  })();
}

function setModelInMemory(config: AutomatonConfig, modelId: string): void {
  config.inferenceModel = modelId;
  if (config.modelStrategy) config.modelStrategy.inferenceModel = modelId;
}

/** Why a stored value may not be used under the current limits, or null if it may. */
function genesisRejection(value: string, limits: ResolvedSettingsLimits): string | null {
  if (!limits.genesisPrompt.allowAgentChanges) return "agent changes to the genesis prompt are off (agentSettings.genesisPrompt.allowAgentChanges)";
  if (value.length > limits.genesisPrompt.maxLength) return `longer than ${limits.genesisPrompt.maxLength} characters`;
  return null;
}

function modelRejection(value: string, limits: ResolvedSettingsLimits): string | null {
  if (!limits.model.allowAgentChanges) return "agent model changes are off (agentSettings.model.allowAgentChanges)";
  if (!limits.model.allowedModels.includes(value)) {
    return `not in the owner's allowed models (${limits.model.allowedModels.join(", ") || "none"})`;
  }
  return null;
}

/**
 * Startup: apply the agent's stored settings that still meet the owner's
 * current limits. Call right after loading the config.
 */
export function applyAgentSettings(
  config: AutomatonConfig,
  db: Database,
): { applied: AgentSettingKey[]; ignored: { key: AgentSettingKey; why: string }[] } {
  const limits = resolveSettingsLimits(config);
  const applied: AgentSettingKey[] = [];
  const ignored: { key: AgentSettingKey; why: string }[] = [];

  const genesis = readStored(db, "genesis_prompt");
  if (genesis) {
    const why = genesisRejection(genesis.value, limits);
    if (why) ignored.push({ key: "genesis_prompt", why });
    else {
      config.genesisPrompt = genesis.value;
      applied.push("genesis_prompt");
    }
  }

  const model = readStored(db, "inference_model");
  if (model) {
    const why = modelRejection(model.value, limits);
    if (why) ignored.push({ key: "inference_model", why });
    else {
      setModelInMemory(config, model.value);
      applied.push("inference_model");
    }
  }

  return { applied, ignored };
}

/** update_genesis_prompt: `sanitized` must already be sanitized. */
export function setGenesisPromptByAgent(
  config: AutomatonConfig,
  db: Database,
  sanitized: string,
  reason: string,
  now: Date = new Date(),
): SettingResult {
  const limits = resolveSettingsLimits(config);
  const why = genesisRejection(sanitized, limits);
  if (why) return { ok: false, error: `Genesis prompt not changed: ${why}.` };
  const used = agentChangesToday(db, "genesis_prompt", now);
  if (used >= limits.genesisPrompt.maxChangesPerDay) {
    return { ok: false, error: `Genesis prompt not changed: daily limit reached (${used}/${limits.genesisPrompt.maxChangesPerDay} today, UTC).` };
  }
  store(db, "genesis_prompt", sanitized, reason, now);
  config.genesisPrompt = sanitized;
  return { ok: true, message: `Genesis prompt updated (${sanitized.length} chars), stored in the database.` };
}

/** switch_model: registry checks (exists, enabled) stay with the caller. */
export function setInferenceModelByAgent(
  config: AutomatonConfig,
  db: Database,
  modelId: string,
  reason: string,
  now: Date = new Date(),
): SettingResult {
  const limits = resolveSettingsLimits(config);
  const why = modelRejection(modelId, limits);
  if (why) return { ok: false, error: `Model '${modelId}' not switched: ${why}.` };
  const used = agentChangesToday(db, "inference_model", now);
  if (used >= limits.model.maxChangesPerDay) {
    return { ok: false, error: `Model not switched: daily limit reached (${used}/${limits.model.maxChangesPerDay} today, UTC).` };
  }
  store(db, "inference_model", modelId, reason, now);
  setModelInMemory(config, modelId);
  return { ok: true, message: `Inference model switched to ${modelId}, stored in the database.` };
}

/** Owner: remove the agent's stored values (history is kept). */
export function resetAgentSettings(db: Database, now: Date = new Date()): AgentSettingKey[] {
  const keys = (db.prepare("SELECT key FROM agent_settings ORDER BY key").all() as { key: AgentSettingKey }[]).map((r) => r.key);
  const ts = now.toISOString();
  db.transaction(() => {
    for (const key of keys) {
      db.prepare("INSERT INTO agent_settings_changes (key, actor, value, reason, changed_at) VALUES (?, 'owner', '', 'reset by owner', ?)").run(key, ts);
    }
    db.prepare("DELETE FROM agent_settings").run();
  })();
  return keys;
}

const preview = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s);

/** Owner: human-readable report of config value, agent value and effective value. */
export function settingsReport(config: AutomatonConfig, db: Database, now: Date = new Date()): string {
  const limits = resolveSettingsLimits(config);
  const baseline = captureBaseline(config);
  const genesis = readStored(db, "genesis_prompt");
  const model = readStored(db, "inference_model");
  const gWhy = genesis ? genesisRejection(genesis.value, limits) : null;
  const mWhy = model ? modelRejection(model.value, limits) : null;
  const lines = [
    "=== AGENT SETTINGS ===",
    "Genesis prompt",
    `  owner config:  ${preview(baseline.genesisPrompt) || "(empty)"}`,
    `  agent value:   ${genesis ? `${preview(genesis.value)}  [${genesis.updated_at}, reason: ${preview(genesis.reason, 80)}]` : "(none)"}`,
    `  effective:     ${genesis && !gWhy ? "agent value" : "owner config"}${genesis && gWhy ? ` (agent value ignored: ${gWhy})` : ""}`,
    `  limits:        agent changes ${limits.genesisPrompt.allowAgentChanges ? "ON" : "OFF"}, max ${limits.genesisPrompt.maxChangesPerDay}/day, max ${limits.genesisPrompt.maxLength} chars, used today ${agentChangesToday(db, "genesis_prompt", now)}`,
    "Inference model",
    `  owner config:  ${baseline.inferenceModel}`,
    `  agent value:   ${model ? `${model.value}  [${model.updated_at}, reason: ${preview(model.reason, 80)}]` : "(none)"}`,
    `  effective:     ${model && !mWhy ? model.value : baseline.inferenceModel}${model && mWhy ? ` (agent value ignored: ${mWhy})` : ""}`,
    `  limits:        agent changes ${limits.model.allowAgentChanges ? "ON" : "OFF"}, allowed: ${limits.model.allowedModels.join(", ") || "none"}, max ${limits.model.maxChangesPerDay}/day, used today ${agentChangesToday(db, "inference_model", now)}`,
    "======================",
  ];
  return lines.join("\n");
}
