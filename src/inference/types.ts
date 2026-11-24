/**
 * Inference & Model Strategy — Internal Types
 *
 * Re-exports shared types from types.ts and defines internal constants
 * for the inference routing subsystem.
 */

export type {
  SurvivalTier,
  ModelProvider,
  InferenceTaskType,
  ModelEntry,
  ModelPreference,
  RoutingMatrix,
  InferenceRequest,
  InferenceResult,
  InferenceCostRow,
  ModelRegistryRow,
  ModelStrategyConfig,
  ChatMessage,
} from "../types.js";

import type {
  RoutingMatrix,
  ModelEntry,
  ModelStrategyConfig,
  SurvivalTier,
  InferenceTaskType,
} from "../types.js";

// === Default Retry Policy ===

export const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

// === Per-Task Timeout Overrides (ms) ===

export const TASK_TIMEOUTS: Record<string, number> = {
  heartbeat_triage: 15_000,
  safety_check: 30_000,
  summarization: 60_000,
  agent_turn: 120_000,
  planning: 120_000,
};

// === Static Model Baseline ===
// Known models with realistic pricing (hundredths of cents per 1k tokens)

export const STATIC_MODEL_BASELINE: Omit<ModelEntry, "lastSeen" | "createdAt" | "updatedAt">[] = [
  {
    modelId: "gpt-5.2",
    provider: "openai",
    displayName: "GPT-5.2",
    tierMinimum: "normal",
    costPer1kInput: 18,    // $1.75/M = 175 cents/M = 0.175 cents/1k = 17.5 hundredths ≈ 18
    costPer1kOutput: 140,  // $14.00/M = 1400 cents/M = 1.4 cents/1k = 140 hundredths
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-4.1-mini",
    provider: "openai",
    displayName: "GPT-4.1 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 4,     // $0.40/M
    costPer1kOutput: 16,   // $1.60/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  // Fork: gpt-4.1-nano removed (OpenAI shut it down on 2026-10-23); the registry
  // disables it on startup. gpt-6-luna (owner decision 2026-11-24) replaces it:
  // standard $0.10 / $0.50 per 1M tokens (cached input $0.01, counted here at the
  // full input price, so the recorded cost is never too low). On Chat Completions
  // it takes tool calls only with reasoning_effort "none" (modelStrategy.reasoningEffort).
  {
    modelId: "gpt-6-luna",
    provider: "openai",
    displayName: "GPT-6 Luna",
    tierMinimum: "critical",
    costPer1kInput: 1,     // $0.10/M
    costPer1kOutput: 5,    // $0.50/M
    maxTokens: 128000,
    contextWindow: 1050000,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 Mini",
    tierMinimum: "low_compute",
    costPer1kInput: 8,     // $0.80/M
    costPer1kOutput: 32,   // $3.20/M
    maxTokens: 16384,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
  {
    modelId: "gpt-5.3",
    provider: "openai",
    displayName: "GPT-5.3",
    tierMinimum: "normal",
    costPer1kInput: 20,    // $2.00/M
    costPer1kOutput: 80,   // $8.00/M
    maxTokens: 32768,
    contextWindow: 1047576,
    supportsTools: true,
    supportsVision: true,
    parameterStyle: "max_completion_tokens",
    enabled: true,
  },
];

// === Routing Matrix ===
// Maps (tier, taskType) -> ModelPreference. Fork (after the tier walk's nano 404):
// the table holds model SLOTS, not model names; the names come from the owner's
// modelStrategy settings (main = inferenceModel, cheap = lowComputeModel,
// critical = criticalModel), so a retired model is replaced in the config only.
// Candidates are tried in order (the first one present and enabled in the registry).

export type ModelSlot = "main" | "cheap" | "critical";

interface SlotPreference {
  slots: ModelSlot[];
  maxTokens: number;
  ceilingCents: number; // max cost per call (-1 = no limit)
}

const NONE: SlotPreference = { slots: [], maxTokens: 0, ceilingCents: 0 };

export const ROUTING_SLOTS: Record<SurvivalTier, Record<InferenceTaskType, SlotPreference>> = {
  high: {
    agent_turn: { slots: ["main"], maxTokens: 8192, ceilingCents: -1 },
    heartbeat_triage: { slots: ["cheap"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { slots: ["main"], maxTokens: 4096, ceilingCents: 20 },
    summarization: { slots: ["main"], maxTokens: 4096, ceilingCents: 15 },
    planning: { slots: ["main"], maxTokens: 8192, ceilingCents: -1 },
  },
  normal: {
    agent_turn: { slots: ["main", "cheap"], maxTokens: 4096, ceilingCents: -1 },
    heartbeat_triage: { slots: ["cheap"], maxTokens: 2048, ceilingCents: 5 },
    safety_check: { slots: ["main", "cheap"], maxTokens: 4096, ceilingCents: 10 },
    summarization: { slots: ["main", "cheap"], maxTokens: 4096, ceilingCents: 10 },
    planning: { slots: ["main", "cheap"], maxTokens: 4096, ceilingCents: -1 },
  },
  low_compute: {
    // Fork (Phase 4 step 3, F5, owner-approved): low_compute agent turns use the
    // cheap model (was the main model, the same as normal).
    agent_turn: { slots: ["cheap"], maxTokens: 4096, ceilingCents: 10 },
    heartbeat_triage: { slots: ["cheap"], maxTokens: 1024, ceilingCents: 2 },
    safety_check: { slots: ["cheap"], maxTokens: 2048, ceilingCents: 5 },
    summarization: { slots: ["cheap"], maxTokens: 2048, ceilingCents: 5 },
    planning: { slots: ["cheap"], maxTokens: 2048, ceilingCents: 5 },
  },
  critical: {
    agent_turn: { slots: ["critical"], maxTokens: 2048, ceilingCents: 3 },
    heartbeat_triage: { slots: ["critical"], maxTokens: 512, ceilingCents: 1 },
    safety_check: { slots: ["critical"], maxTokens: 1024, ceilingCents: 2 },
    summarization: NONE,
    planning: NONE,
  },
  dead: {
    agent_turn: NONE,
    heartbeat_triage: NONE,
    safety_check: NONE,
    summarization: NONE,
    planning: NONE,
  },
};

/** The routing matrix for the owner's model settings (model names filled into the slots). */
export function buildRoutingMatrix(
  strategy: Pick<ModelStrategyConfig, "inferenceModel" | "lowComputeModel" | "criticalModel">,
): RoutingMatrix {
  const slotModel: Record<ModelSlot, string> = {
    main: strategy.inferenceModel,
    cheap: strategy.lowComputeModel,
    critical: strategy.criticalModel,
  };
  const matrix = {} as RoutingMatrix;
  for (const [tier, tasks] of Object.entries(ROUTING_SLOTS) as [SurvivalTier, Record<InferenceTaskType, SlotPreference>][]) {
    matrix[tier] = {} as RoutingMatrix[SurvivalTier];
    for (const [task, pref] of Object.entries(tasks) as [InferenceTaskType, SlotPreference][]) {
      const candidates = [...new Set(pref.slots.map((s) => slotModel[s]).filter((m): m is string => !!m))];
      matrix[tier][task] = { candidates, maxTokens: pref.maxTokens, ceilingCents: pref.ceilingCents };
    }
  }
  return matrix;
}

// === Default Model Strategy Config ===
// One definition (src/types.ts), re-exported here.

export { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG as DEFAULTS } from "../types.js";

/** The matrix for the code defaults (tests and documentation). */
export const DEFAULT_ROUTING_MATRIX: RoutingMatrix = buildRoutingMatrix(DEFAULTS);

/**
 * Fork: OpenAI reasoning models (gpt-5 and later, o-series). They take
 * `max_completion_tokens` and `reasoning_effort`; gpt-4.x models take neither
 * `reasoning_effort` nor need it. Chat variants (`*-chat*`) are not reasoning models.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-([5-9]|[1-9]\d))/i.test(model) && !/-chat/i.test(model);
}
