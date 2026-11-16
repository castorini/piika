/**
 * Reranking configuration for the search tool.
 *
 * Reranking is opt-in: with no config the search tool behaves exactly as before,
 * so the no-reranker arm of an experiment is the untouched code path rather than
 * a differently-configured one.
 *
 * Ranking itself is not implemented here. Prompt construction, scoring and
 * permutation live in rank_llm, reached through a small worker process that
 * imports it as a library (scripts/rank_llm_rerank_worker.py); this config only
 * says where that worker is and what context to give it. Keeping one
 * implementation avoids two copies of a prompt drifting apart, which for a
 * cross-encoder means silently scoring against a prompt the model was never
 * trained on.
 *
 * The benchmark runners take it as --rerank-* flags (RERANK_CLI_FLAGS below);
 * the pi extension reads it from PI_SEARCH_RERANK_CONFIG, which the runner sets
 * for each pi process when reranking is on.
 */
import { Type, type Static } from "typebox";
import { compileJsonValidator, type JsonValidationError } from "../protocol/validation";

const ContextModeSchema = Type.Union([
  Type.Literal("none"), // query only, i.e. the stock reranker prompt
  Type.Literal("global_query"), // + the question that motivated the session
  Type.Literal("reasoning"), // + the agent's reasoning behind this query
  Type.Literal("full"), // both
]);

export const PiSearchRerankConfigSchema = Type.Object(
  {
    /** Base URL of the rank_llm worker, e.g. http://127.0.0.1:8200 */
    workerUrl: Type.String({ minLength: 1 }),
    /**
     * Context the worker may use. Never more than this, and per call less when
     * the agent did not produce it: the reranker prompts state which fields are
     * present, so an empty field would contradict its own instruction.
     */
    contextMode: Type.Optional(ContextModeSchema),
    /** Candidates fetched from the first stage and handed to the reranker. */
    depth: Type.Optional(Type.Number({ minimum: 1 })),
    /** Characters of reasoning trace passed through; trimmed keeping the head. */
    maxTraceChars: Type.Optional(Type.Number({ minimum: 1 })),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    retryAttempts: Type.Optional(Type.Number({ minimum: 1 })),
    retryBaseDelayMs: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type PiSearchRerankConfig = Static<typeof PiSearchRerankConfigSchema>;
export type PiSearchRerankContextMode = Static<typeof ContextModeSchema>;

export const RERANK_DEFAULTS = {
  depth: 100,
  maxTraceChars: 2048,
  timeoutMs: 300_000,
  // Transient worker failures are retried with exponential backoff (1, 2, 4 s
  // with jitter) before the rerank, and with it the run, is failed.
  retryAttempts: 4,
  retryBaseDelayMs: 1000,
} as const;

const rerankConfigValidator = compileJsonValidator(PiSearchRerankConfigSchema);

function formatValidationErrors(errors: JsonValidationError[]): string {
  if (!errors || errors.length === 0) return "schema validation failed without detailed errors.";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`.trim())
    .join("; ");
}

export function parsePiSearchRerankConfig(text: string): PiSearchRerankConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse PI_SEARCH_RERANK_CONFIG: ${text}\n${String(error)}`);
  }
  if (rerankConfigValidator.check(value)) return value;
  throw new Error(
    `Invalid PI_SEARCH_RERANK_CONFIG: ${formatValidationErrors(rerankConfigValidator.errors(value))}`,
  );
}

/** Absent config means no reranking, which is the untouched search path. */
export function resolvePiSearchRerankConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PiSearchRerankConfig | null {
  const raw = env.PI_SEARCH_RERANK_CONFIG?.trim();
  if (!raw) return null;
  return parsePiSearchRerankConfig(raw);
}

/**
 * Benchmark-runner flags for the rerank config, keyed by the camelCase name the
 * runners' argument parsers produce (`--rerank-worker-url` -> rerankWorkerUrl).
 */
export const RERANK_CLI_FLAGS = {
  rerankWorkerUrl: "workerUrl",
  rerankContextMode: "contextMode",
  rerankDepth: "depth",
  rerankMaxTraceChars: "maxTraceChars",
  rerankTimeoutMs: "timeoutMs",
  rerankRetryAttempts: "retryAttempts",
  rerankRetryBaseDelayMs: "retryBaseDelayMs",
} as const satisfies Record<string, keyof PiSearchRerankConfig>;

export type RerankCliFlag = keyof typeof RERANK_CLI_FLAGS;
export type RerankCliFlags = Partial<Record<RerankCliFlag, string>>;

const kebab = (flag: string) => flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The rerank flags present in a parsed argument map (other keys are ignored). */
export function pickRerankCliFlags(args: Record<string, string | undefined>): RerankCliFlags {
  const flags: RerankCliFlags = {};
  for (const flag of Object.keys(RERANK_CLI_FLAGS) as RerankCliFlag[]) {
    const value = args[flag]?.trim();
    if (value) flags[flag] = value;
  }
  return flags;
}

/** The flags as runner arguments, e.g. for a launcher that spawns run_pi_benchmark. */
export function formatRerankCliArgs(flags: RerankCliFlags): string[] {
  return (Object.keys(RERANK_CLI_FLAGS) as RerankCliFlag[]).flatMap((flag) =>
    flags[flag] ? [`--${flag}`, flags[flag] as string] : [],
  );
}

/** A config from the rerank flags; null when none is given (no reranking). */
export function buildPiSearchRerankConfigFromFlags(
  flags: RerankCliFlags,
): PiSearchRerankConfig | null {
  const given = (Object.keys(RERANK_CLI_FLAGS) as RerankCliFlag[]).filter((flag) => flags[flag]);
  if (given.length === 0) return null;
  if (!flags.rerankWorkerUrl) {
    throw new Error(
      `--${kebab(given[0])} needs --rerank-worker-url: reranking is enabled by naming the worker`,
    );
  }
  const config: Record<string, unknown> = {};
  for (const flag of given) {
    const key = RERANK_CLI_FLAGS[flag];
    const raw = flags[flag] as string;
    if (key === "workerUrl" || key === "contextMode") {
      config[key] = raw;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`--${kebab(flag)} must be a number; received ${raw}`);
    }
    config[key] = value;
  }
  if (rerankConfigValidator.check(config)) return config;
  throw new Error(
    `Invalid --rerank-* flags: ${formatValidationErrors(rerankConfigValidator.errors(config))}`,
  );
}

/**
 * The run's rerank config: from the flags, else from PI_SEARCH_RERANK_CONFIG,
 * else null (no reranking). Setting both is refused rather than merged.
 */
export function resolvePiSearchRerankConfig(
  flags: RerankCliFlags,
  env: NodeJS.ProcessEnv = process.env,
): PiSearchRerankConfig | null {
  const fromFlags = buildPiSearchRerankConfigFromFlags(flags);
  const fromEnv = resolvePiSearchRerankConfigFromEnv(env);
  if (fromFlags && fromEnv) {
    throw new Error(
      "Configure reranking with --rerank-* flags or PI_SEARCH_RERANK_CONFIG, not both",
    );
  }
  return fromFlags ?? fromEnv;
}
