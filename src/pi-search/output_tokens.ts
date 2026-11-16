/**
 * Request-level overrides for the model provider payload.
 *
 * Output cap: pi-ai sends `min(model.maxTokens, 32000)` unless a caller passes
 * `maxTokens`, and pi exposes no setting for it, so a model whose `maxTokens`
 * is 32,768 is silently capped at 32,000. PI_SEARCH_MAX_OUTPUT_TOKENS sets the
 * cap the payload carries.
 *
 * Sampling: pi sends no penalty or sampling fields to OpenAI-compatible
 * servers. PI_SEARCH_SAMPLING_OVERRIDES is a JSON object of numeric sampling
 * fields (e.g. {"presence_penalty": 1.0}) merged into every payload.
 *
 * Both are applied through pi's `before_provider_request` hook. Unset: no
 * handler is registered and payloads are exactly what pi built.
 */

const OUTPUT_TOKEN_FIELDS = ["max_completion_tokens", "max_tokens", "max_output_tokens"] as const;

/** Sampling fields an OpenAI-compatible server (vLLM included) accepts per request. */
export const SAMPLING_OVERRIDE_FIELDS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
  "repetition_penalty",
  "seed",
] as const;
export type SamplingOverrides = Partial<Record<(typeof SAMPLING_OVERRIDE_FIELDS)[number], number>>;

export function resolveMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.PI_SEARCH_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`PI_SEARCH_MAX_OUTPUT_TOKENS must be a positive integer; received ${raw}`);
  }
  return parsed;
}

export function resolveSamplingOverrides(
  env: NodeJS.ProcessEnv = process.env,
): SamplingOverrides | undefined {
  const raw = env.PI_SEARCH_SAMPLING_OVERRIDES?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PI_SEARCH_SAMPLING_OVERRIDES is not JSON: ${raw}\n${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PI_SEARCH_SAMPLING_OVERRIDES must be a JSON object; received ${raw}`);
  }
  const overrides: SamplingOverrides = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(SAMPLING_OVERRIDE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `PI_SEARCH_SAMPLING_OVERRIDES: unsupported field ${key}; allowed: ${SAMPLING_OVERRIDE_FIELDS.join(", ")}`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `PI_SEARCH_SAMPLING_OVERRIDES: ${key} must be a finite number; received ${String(value)}`,
      );
    }
    overrides[key as keyof SamplingOverrides] = value;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * The payload with every output-token field it carries set to `cap`. A payload
 * that carries none gets `max_tokens`, the field OpenAI-compatible chat servers
 * (vLLM among them) read. Non-object payloads are returned unchanged.
 */
export function applyMaxOutputTokens(payload: unknown, cap: number): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  const present = OUTPUT_TOKEN_FIELDS.filter((field) => field in next);
  for (const field of present.length > 0 ? present : (["max_tokens"] as const)) {
    next[field] = cap;
  }
  return next;
}

/** The payload with the overrides set (replacing any value pi put there). */
export function applySamplingOverrides(payload: unknown, overrides: SamplingOverrides): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), ...overrides };
}
