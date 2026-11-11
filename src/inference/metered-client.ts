/**
 * Metered Inference Client (fork, Phase 1)
 *
 * Wraps UnifiedInferenceClient so every call is checked against the shared
 * InferenceBudgetTracker before it runs, and its cost is written to
 * inference_costs and the append-only ledger after it runs. The orchestrator,
 * planner and local workers must only ever get this wrapper, never the raw
 * client (see the inference choke-point test).
 *
 * Prices: ProviderRegistry prices are dollars per 1M tokens. A remote model is
 * never charged less than its built-in price, and a remote model with no known
 * price is charged at the highest built-in price. Only providers on a loopback
 * address (local Ollama/vLLM) are free.
 */

import type { InferenceTaskType } from "../types.js";
import type { InferenceBudgetTracker } from "./budget.js";
import type {
  UnifiedChatDirectParams,
  UnifiedChatParams,
  UnifiedInferenceClient,
  UnifiedInferenceResult,
} from "./inference-client.js";
import {
  getBuiltinModelPrice,
  getHighestBuiltinPrice,
  type ModelConfig,
  type ProviderConfig,
  type ProviderRegistry,
  type ResolvedModel,
} from "./provider-registry.js";

/** Per-call ceiling used for the default output cap when the config sets none. */
export const DEFAULT_CALL_CEILING_CENTS = 5;

/** Thrown when a call is refused by a budget cap. No model was called. */
export class InferenceBudgetExceededError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Inference budget exceeded: ${reason}`);
    this.name = "InferenceBudgetExceededError";
    this.reason = reason;
  }
}

export function isInferenceBudgetExceededError(error: unknown): error is InferenceBudgetExceededError {
  return (
    error instanceof InferenceBudgetExceededError ||
    (error instanceof Error && error.name === "InferenceBudgetExceededError")
  );
}

/** The only inference interface the orchestrator, planner and workers get. */
export interface MeteredInference {
  chat(params: UnifiedChatParams): Promise<UnifiedInferenceResult>;
  chatDirect(params: UnifiedChatDirectParams): Promise<UnifiedInferenceResult>;
}

export interface MeteredInferenceOptions {
  /** Ledger source label, e.g. "orchestrator" or "worker". */
  source: string;
  /** Task type stored in inference_costs. */
  taskType: InferenceTaskType;
  /** Session id for the session budget; defaults to "default". */
  getSessionId?: () => string;
}

/** Dollars per 1M tokens. */
interface Price {
  input: number;
  output: number;
}

interface CallPlan {
  price: Price;
  free: boolean;
  maxOutputTokens: number | undefined;
}

export class MeteredInferenceClient implements MeteredInference {
  constructor(
    private readonly inner: Pick<UnifiedInferenceClient, "chat" | "chatDirect">,
    private readonly registry: ProviderRegistry,
    private readonly budget: InferenceBudgetTracker,
    private readonly options: MeteredInferenceOptions,
  ) {}

  async chat(params: UnifiedChatParams): Promise<UnifiedInferenceResult> {
    const plan = this.planForCandidates(this.candidatesForTier(params.tier));
    const bounded = this.admit(params, plan, `tier:${params.tier}`);
    const result = await this.inner.chat(bounded.params);
    this.record(result, params.tier, bounded.estimateCents);
    return result;
  }

  async chatDirect(params: UnifiedChatDirectParams): Promise<UnifiedInferenceResult> {
    const found = this.findModel(params.providerId, params.modelId);
    const plan = found
      ? this.planForCandidates([found])
      : { price: getHighestBuiltinPrice(), free: false, maxOutputTokens: undefined };
    const bounded = this.admit(params, plan, params.modelId);
    const result = await this.inner.chatDirect(bounded.params);
    this.record(result, found?.model.tier ?? "unknown", bounded.estimateCents);
    return result;
  }

  /**
   * Estimate the worst-case cost, apply the default output cap, and check
   * every budget. Throws InferenceBudgetExceededError if any cap refuses.
   */
  private admit<P extends UnifiedChatParams | UnifiedChatDirectParams>(
    params: P,
    plan: CallPlan,
    modelLabel: string,
  ): { params: P; estimateCents: number } {
    const inputTokens = estimateInputTokens(params);
    const inCents = centsPerToken(plan.price.input);
    const outCents = centsPerToken(plan.price.output);

    let maxTokens = params.maxTokens;
    if (maxTokens === undefined) {
      maxTokens = this.defaultOutputCap(inputTokens * inCents, outCents, plan.maxOutputTokens);
    }

    const estimateCents = plan.free
      ? 0
      : Math.ceil(inputTokens * inCents + maxTokens * outCents);

    const check = this.budget.checkBudget(estimateCents, modelLabel);
    if (!check.allowed) {
      throw new InferenceBudgetExceededError(check.reason ?? "budget cap reached");
    }

    const sessionLimit = this.budget.config.sessionBudgetCents;
    if (sessionLimit > 0 && estimateCents > 0) {
      const spent = this.budget.getSessionCost(this.sessionId());
      if (spent + estimateCents > sessionLimit) {
        throw new InferenceBudgetExceededError(
          `Session budget exceeded: ${spent}c spent + ${estimateCents}c estimated > ${sessionLimit}c limit`,
        );
      }
    }

    return { params: { ...params, maxTokens }, estimateCents };
  }

  /**
   * Largest output that keeps the call within the per-call ceiling on the
   * priciest candidate model, clamped to the smallest model output limit.
   */
  private defaultOutputCap(
    inputCostCents: number,
    outCentsPerToken: number,
    maxOutputTokens: number | undefined,
  ): number {
    const limit = maxOutputTokens ?? Number.MAX_SAFE_INTEGER;
    if (outCentsPerToken <= 0) {
      return maxOutputTokens ?? 4096;
    }
    const configured = this.budget.config.perCallCeilingCents;
    const ceiling = configured > 0 ? configured : DEFAULT_CALL_CEILING_CENTS;
    const remaining = ceiling - inputCostCents;
    const tokens = Math.floor(remaining / outCentsPerToken - 1e-9);
    return Math.max(1, Math.min(limit, tokens));
  }

  private record(result: UnifiedInferenceResult, tier: string, estimateCents: number): void {
    const found = this.findModel(result.metadata.providerId, result.metadata.modelId);
    const free = found ? isFreeProvider(found.provider) : false;
    const price = found ? effectivePrice(found.provider, found.model) : getHighestBuiltinPrice();

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;

    let costCents = 0;
    if (!free) {
      costCents = Math.ceil(
        inputTokens * centsPerToken(price.input) + outputTokens * centsPerToken(price.output),
      );
      // A paid call that reports no usage (e.g. a stream without a usage
      // chunk) is charged at its estimate, never 0.
      if (inputTokens === 0 && outputTokens === 0) {
        costCents = estimateCents;
      }
    }

    this.budget.recordCost(
      {
        sessionId: this.sessionId(),
        turnId: null,
        model: result.metadata.modelId,
        provider: result.metadata.providerId,
        inputTokens,
        outputTokens,
        costCents,
        latencyMs: result.metadata.latencyMs,
        tier,
        taskType: this.options.taskType,
        cacheHit: false,
      },
      this.options.source,
    );
  }

  private candidatesForTier(tier: UnifiedChatParams["tier"]): ResolvedModel[] {
    // The inner client may switch to survival mode; take both candidate sets.
    return [
      ...this.registry.resolveCandidates(tier, false),
      ...this.registry.resolveCandidates(tier, true),
    ];
  }

  private planForCandidates(
    candidates: Array<Pick<ResolvedModel, "provider" | "model">>,
  ): CallPlan {
    if (candidates.length === 0) {
      return { price: getHighestBuiltinPrice(), free: false, maxOutputTokens: undefined };
    }
    let input = 0;
    let output = 0;
    let free = true;
    let maxOutputTokens: number | undefined;
    for (const c of candidates) {
      const price = effectivePrice(c.provider, c.model);
      input = Math.max(input, price.input);
      output = Math.max(output, price.output);
      if (!isFreeProvider(c.provider)) free = false;
      const limit = c.model.maxOutputTokens;
      if (Number.isFinite(limit) && limit > 0) {
        maxOutputTokens = maxOutputTokens === undefined ? limit : Math.min(maxOutputTokens, limit);
      }
    }
    return { price: { input, output }, free, maxOutputTokens };
  }

  private findModel(
    providerId: string,
    modelId: string,
  ): { provider: ProviderConfig; model: ModelConfig } | undefined {
    const provider = this.registry.getProviders().find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    return provider && model ? { provider, model } : undefined;
  }

  private sessionId(): string {
    return this.options.getSessionId?.() || "default";
  }
}

/** Dollars per 1M tokens → cents per token. */
function centsPerToken(dollarsPerMillion: number): number {
  return dollarsPerMillion / 10_000;
}

function isFreeProvider(provider: ProviderConfig): boolean {
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function effectivePrice(provider: ProviderConfig, model: ModelConfig): Price {
  if (isFreeProvider(provider)) {
    return { input: 0, output: 0 };
  }
  const configuredIn = validPrice(model.costPerInputToken);
  const configuredOut = validPrice(model.costPerOutputToken);
  const builtin = getBuiltinModelPrice(model.id);
  const input = Math.max(configuredIn, builtin?.input ?? 0);
  const output = Math.max(configuredOut, builtin?.output ?? 0);
  // A remote model is never free; a zero price means "unknown".
  if (input > 0 && output > 0) {
    return { input, output };
  }
  return getHighestBuiltinPrice();
}

function validPrice(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateInputTokens(params: UnifiedChatParams | UnifiedChatDirectParams): number {
  let chars = 0;
  for (const m of params.messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (params.tools && params.tools.length > 0) {
    chars += JSON.stringify(params.tools).length;
  }
  return Math.ceil(chars / 4);
}
