/**
 * Client for the rank_llm rerank worker.
 *
 * Holds no ranking logic: it forwards the query, the agent context it is allowed
 * to send, and the first-stage candidates, then applies the order that comes
 * back. rank_llm owns prompt construction, scoring and permutation.
 *
 * A failed worker call is retried with exponential backoff; what still fails
 * is raised as PiSearchRerankError, so the search call fails rather than
 * continuing on first-stage order: every search that returns results was
 * actually reranked.
 */
import {
  RERANK_DEFAULTS,
  type PiSearchRerankConfig,
  type PiSearchRerankContextMode,
} from "./config";

const RERANK_MAX_DELAY_MS = 15_000;

/** The reranker could not produce a ranking; the run must not continue on first-stage order. */
export class PiSearchRerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSearchRerankError";
  }
}

export type RerankInputCandidate = { docid: string; score?: number; text: string };

export type RerankResult = {
  docids: string[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  contextFields: string[];
  depth: number;
  failed: boolean;
  elapsedMs: number;
};

export type AgentContext = { globalQuery?: string; reasoning?: string };

/**
 * Context fields this run is permitted to send.
 *
 * Never more than the configured mode, and per call less when the agent did not
 * produce the field. The reranker prompt announces which fields are present, so
 * sending an empty one would contradict the instruction the model was trained
 * against; omitting it selects the matching lower mode instead.
 */
export function selectContextFields(
  mode: PiSearchRerankContextMode,
  context: AgentContext,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const globalQuery = context.globalQuery?.trim();
  const reasoning = context.reasoning?.trim();
  if ((mode === "global_query" || mode === "full") && globalQuery) {
    fields.global_query = globalQuery;
  }
  if ((mode === "reasoning" || mode === "full") && reasoning) {
    fields.reasoning = reasoning;
  }
  return fields;
}

export class RerankWorkerClient {
  private readonly workerUrl: string;
  private readonly contextMode: PiSearchRerankContextMode;
  private readonly depth: number;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: PiSearchRerankConfig) {
    this.workerUrl = config.workerUrl.replace(/\/+$/, "");
    this.contextMode = config.contextMode ?? "none";
    this.depth = config.depth ?? RERANK_DEFAULTS.depth;
    this.timeoutMs = config.timeoutMs ?? RERANK_DEFAULTS.timeoutMs;
    this.retryAttempts = config.retryAttempts ?? RERANK_DEFAULTS.retryAttempts;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? RERANK_DEFAULTS.retryBaseDelayMs;
  }

  get configuredDepth(): number {
    return this.depth;
  }

  async rerank(
    qid: string,
    query: string,
    candidates: RerankInputCandidate[],
    topK: number,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<RerankResult> {
    const startedAt = performance.now();
    const fallback = (): RerankResult => ({
      docids: candidates.slice(0, topK).map((candidate) => candidate.docid),
      usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
      contextFields: [],
      depth: Math.min(this.depth, candidates.length),
      failed: true,
      elapsedMs: performance.now() - startedAt,
    });

    if (candidates.length === 0) return { ...fallback(), failed: false };

    const body = {
      qid,
      query,
      query_fields: selectContextFields(this.contextMode, context),
      candidates: candidates.slice(0, this.depth),
      depth: Math.min(this.depth, candidates.length),
      top_k: topK,
    };

    // A failed rerank is an error for the run, not a quiet return to first
    // stage order: transient failures are retried with exponential backoff,
    // and what still fails is thrown for the caller to abort on.
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.requestOnce(body, candidates, topK, startedAt, signal);
      } catch (error) {
        lastError = error;
        if (attempt === this.retryAttempts || signal?.aborted) break;
        const delayMs = Math.round(
          Math.min(RERANK_MAX_DELAY_MS, this.retryBaseDelayMs * 2 ** (attempt - 1)) *
            (0.5 + Math.random()),
        );
        console.error(
          `[pi-search] rerank failed (${error instanceof Error ? error.message : String(error)}); ` +
            `retry ${attempt}/${this.retryAttempts - 1} in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new PiSearchRerankError(
      `rerank worker at ${this.workerUrl} failed after ${this.retryAttempts} attempts: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async requestOnce(
    body: Record<string, unknown>,
    candidates: RerankInputCandidate[],
    topK: number,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<RerankResult> {
    {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(`${this.workerUrl}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: composite,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const parsed = (await response.json()) as {
        docids?: unknown;
        usage?: { prompt_tokens?: number; completion_tokens?: number; calls?: number };
        context_fields?: unknown;
        depth?: number;
      };
      const docids = Array.isArray(parsed.docids)
        ? parsed.docids.filter((id): id is string => typeof id === "string")
        : [];
      if (docids.length === 0) throw new Error("worker returned no docids");

      return {
        docids,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          calls: parsed.usage?.calls ?? 0,
        },
        contextFields: Array.isArray(parsed.context_fields)
          ? parsed.context_fields.filter((f): f is string => typeof f === "string")
          : [],
        depth: parsed.depth ?? (body.depth as number),
        failed: false,
        elapsedMs: performance.now() - startedAt,
      };
    }
  }
}
