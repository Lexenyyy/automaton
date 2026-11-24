/**
 * Fork (after the tier walk's gpt-4.1-nano 404): preflight check that every
 * model the agent could use is really offered by its provider.
 *
 * One free `GET /v1/models` per provider with a key (OpenAI, Anthropic); no
 * model call. A model the provider does not list FAILs preflight; a list that
 * cannot be read FAILs too (nothing could be confirmed). A listed model with a
 * shutdown date (OpenAI's `shutdown_date`) gets a WARN with the days left.
 *
 * Never prints key values or provider error bodies (OpenAI's 401 body quotes
 * part of the key): only the HTTP status and the error code.
 */

import { REASONING_EFFORTS, type AutomatonConfig } from "../types.js";
import { resolveSettingsLimits } from "../agent/settings.js";

/** Startup check: modelStrategy.reasoningEffort must be one of the known values (or unset). */
export function checkReasoningEffort(config: AutomatonConfig): string | null {
  const v = (config.modelStrategy as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;
  if (v === undefined) return null;
  return (REASONING_EFFORTS as readonly unknown[]).includes(v)
    ? null
    : `modelStrategy.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")} (got ${JSON.stringify(v)})`;
}

export type ListedProvider = "openai" | "anthropic";

export interface ListedModel {
  id: string;
  /** YYYY-MM-DD, when the provider announces one. */
  shutdownDate?: string;
}

export type ModelList =
  | { ok: true; models: Map<string, ListedModel> }
  | { ok: false; reason: string };

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const LIST_URLS: Record<ListedProvider, string> = {
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models?limit=1000",
};

/** Days before a shutdown date from which the WARN says "SOON". */
export const SHUTDOWN_SOON_DAYS = 30;

/** Every model the agent could use: main and strategy models, plus the models it may switch to. */
export function collectConfiguredModels(config: AutomatonConfig): string[] {
  const s = config.modelStrategy;
  const models = [config.inferenceModel, s?.inferenceModel, s?.lowComputeModel, s?.criticalModel];
  models.push(...resolveSettingsLimits(config).model.allowedModels);
  return [...new Set(models.filter((m): m is string => typeof m === "string" && m.length > 0))];
}

/** shutdown_date as YYYY-MM-DD (the API gives a date string or Unix seconds), else undefined. */
export function parseShutdownDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return undefined;
}

/** One free model list call. Never returns or logs the key or the error body. */
export async function fetchModelList(
  provider: ListedProvider,
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 15_000,
): Promise<ModelList> {
  const headers: Record<string, string> =
    provider === "openai"
      ? { Authorization: `Bearer ${apiKey}` }
      : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(LIST_URLS[provider], { headers, signal: controller.signal });
    if (!resp.ok) {
      let code = "";
      try {
        const body = (await resp.json()) as any;
        const c = body?.error?.code ?? body?.error?.type;
        if (typeof c === "string" && /^[a-z0-9_.-]{1,64}$/i.test(c)) code = `, ${c}`;
      } catch {
        // no JSON body: status only
      }
      const hint = resp.status === 401 || resp.status === 403 ? ", key rejected" : "";
      return { ok: false, reason: `HTTP ${resp.status}${code}${hint}` };
    }
    const body = (await resp.json()) as any;
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    const models = new Map<string, ListedModel>();
    for (const m of data) {
      if (typeof m?.id !== "string") continue;
      models.set(m.id, { id: m.id, shutdownDate: parseShutdownDate(m.shutdown_date) });
    }
    return { ok: true, models };
  } catch (err: any) {
    const why = err?.name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : "unreachable";
    return { ok: false, reason: why };
  } finally {
    clearTimeout(timer);
  }
}

export interface ModelCheckLine {
  level: "PASS" | "WARN" | "FAIL" | "INFO";
  text: string;
}

/**
 * Report lines for the models of one provider. A list that could not be read
 * is one FAIL; its models are then INFO "not checked" (no repeated FAILs).
 */
export function modelCheckLines(
  provider: ListedProvider,
  models: string[],
  list: ModelList,
  now: Date = new Date(),
): ModelCheckLine[] {
  if (!list.ok) {
    return [
      { level: "FAIL", text: `model list (${provider}): could not read (${list.reason}); models not confirmed` },
      ...models.map((m) => ({ level: "INFO" as const, text: `model ${m}: not checked (${provider} model list unavailable)` })),
    ];
  }
  const out: ModelCheckLine[] = [];
  for (const model of models) {
    const listed = list.models.get(model);
    if (!listed) {
      out.push({ level: "FAIL", text: `model ${model}: not offered by ${provider} (retired or unknown); the agent cannot use it` });
      continue;
    }
    if (!listed.shutdownDate) {
      out.push({ level: "PASS", text: `model ${model}: listed by ${provider}, no shutdown date` });
      continue;
    }
    const days = Math.ceil((Date.parse(`${listed.shutdownDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
    out.push({ level: "PASS", text: `model ${model}: listed by ${provider}` });
    out.push({
      level: "WARN",
      text:
        days <= 0
          ? `model ${model}: ${provider} shutdown date ${listed.shutdownDate} has passed; replace it now`
          : `model ${model}: ${provider} shuts it down on ${listed.shutdownDate} (${days} day${days === 1 ? "" : "s"})` +
            (days <= SHUTDOWN_SOON_DAYS ? ", SOON: replace it" : ""),
    });
  }
  return out;
}
