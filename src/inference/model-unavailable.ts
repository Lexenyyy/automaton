/**
 * Fork (after the tier walk's gpt-4.1-nano 404): a model the provider no
 * longer serves (retired, renamed, never existed) is a configuration problem
 * only the owner can fix. It is recognised from the provider's answer and
 * raised as ModelUnavailableError, whose message never carries the response
 * body.
 *
 * The agent loop then ends the wake at once with one ERROR line and the agent
 * stays asleep until the runtime is restarted (model-stop.ts): no retries.
 */

export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";

  constructor(
    readonly model: string,
    readonly provider: string,
    readonly code: string,
  ) {
    super(`Model unavailable: ${model} (${provider}: ${code})`);
  }
}

export function isModelUnavailable(err: unknown): err is ModelUnavailableError {
  return err instanceof ModelUnavailableError || (err as { name?: unknown } | null)?.name === "ModelUnavailableError";
}

/**
 * The provider's answer means "this model is not available", or null.
 * OpenAI: 404 (sometimes 400) with error.code "model_not_found", or a 404
 * saying the model does not exist. Anthropic: 404 not_found_error about the model.
 */
export function modelUnavailableFromResponse(
  status: number,
  bodyText: string,
  model: string,
  provider: string,
): ModelUnavailableError | null {
  if (status !== 404 && status !== 400) return null;
  let code: unknown;
  let type: unknown;
  let message = "";
  try {
    const body = JSON.parse(bodyText) as any;
    code = body?.error?.code;
    type = body?.error?.type;
    message = typeof body?.error?.message === "string" ? body.error.message : "";
  } catch {
    message = bodyText;
  }
  if (code === "model_not_found") return new ModelUnavailableError(model, provider, "model_not_found");
  if (status !== 404) return null;
  if (type === "not_found_error" && /model/i.test(message)) return new ModelUnavailableError(model, provider, "not_found_error");
  if (/model\b.*\b(does not exist|not found|not exist)/i.test(message)) return new ModelUnavailableError(model, provider, "model_not_found");
  return null;
}
