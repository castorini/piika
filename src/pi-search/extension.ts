import { writeSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiSearchExtensionConfigFromEnv, type PiSearchExtensionConfig } from "./config";
import {
  BENCHMARK_TIMEOUT_SECONDS,
  CONTEXT_SUBMIT_NOW_BLOCK_REASON,
  CONTEXT_SUBMIT_NOW_STEER_MESSAGE,
  contextTokensAfterTurn,
  dumpPromptSnapshot,
  getSubmitNowDelayMs,
  isRepeatQueryBlockEnabled,
  normalizeSearchQuery,
  REPEAT_QUERY_BLOCK_MESSAGE,
  resolveSubmitNowPromptTokens,
  stripBenchmarkIrrelevantSystemPromptSections,
  SUBMIT_NOW_BLOCK_REASON,
  SUBMIT_NOW_STEER_MESSAGE,
  SUBMIT_NOW_TRIGGER_RATIO,
} from "./prompt_policy";
import {
  DirectReadDocumentParamsSchema,
  DirectSearchParamsPinnedSchema,
  DirectSearchParamsSchema,
  PlainSearchParamsSchema,
  ReadDocumentParamsSchema,
  ReadSearchResultsParamsSchema,
} from "./protocol/schemas";
import {
  applyMaxOutputTokens,
  applySamplingOverrides,
  resolveMaxOutputTokens,
  resolveSamplingOverrides,
} from "./output_tokens";
import { PiSearchRerankError } from "./rerank/client";
import { SearchSessionStore } from "./search_cache";
import {
  PiSearchBackendExecutionError,
  PiSearchBackendUnavailableError,
} from "./searcher/contract/errors";
import {
  PiSearchBackendRuntime,
  type PiSearchBackendFactory,
  type PiSearchBackendRuntimeOptions,
} from "./searcher/runtime";
import { ManagedTempSpillDir } from "./spill";
import {
  executeDirectReadDocumentTool,
  executeDirectSearchTool,
  executeReadDocumentTool,
  executeReadSearchResultsTool,
  executeSearchTool,
  isDirectSearchHitsCapped,
} from "./tool_handlers";
import { parsePiSearchToolInterface, type PiSearchToolInterface } from "./tool_interface";
import { AgentContextStore, resolveGlobalQuery } from "./agent_context";
import { RerankWorkerClient } from "./rerank/client";
import {
  RERANK_DEFAULTS,
  resolvePiSearchRerankConfigFromEnv,
  type PiSearchRerankConfig,
} from "./rerank/config";

export type { PiSearchToolInterface } from "./tool_interface";

export type PiSearchExtensionOptions = {
  resolveConfig?: (env: NodeJS.ProcessEnv) => PiSearchExtensionConfig;
  backendRuntime?: PiSearchBackendRuntime;
  createBackend?: PiSearchBackendFactory;
  buildCacheKey?: PiSearchBackendRuntimeOptions["buildCacheKey"];
  spillDirPrefix?: string;
  toolInterface?: PiSearchToolInterface;
  rerankConfig?: PiSearchRerankConfig | null;
};

function resolveToolInterface(options: PiSearchExtensionOptions): PiSearchToolInterface {
  return parsePiSearchToolInterface(options.toolInterface ?? process.env.PI_SEARCH_TOOL_INTERFACE);
}

export function registerPiSearchExtension(
  pi: ExtensionAPI,
  options: PiSearchExtensionOptions = {},
): void {
  const extensionConfig =
    options.resolveConfig?.(process.env) ?? resolvePiSearchExtensionConfigFromEnv(process.env);
  const searchStore = new SearchSessionStore();
  const backendRuntime =
    options.backendRuntime ??
    new PiSearchBackendRuntime(extensionConfig, {
      buildCacheKey: options.buildCacheKey,
      createBackend: options.createBackend,
    });
  const spillDir = new ManagedTempSpillDir(options.spillDirPrefix ?? "pi-search-extension-");
  const toolInterface = resolveToolInterface(options);
  // Reranking is opt-in. With no config this is null and the search path is
  // exactly the behaviour without reranking.
  const rerankConfig = options.rerankConfig ?? resolvePiSearchRerankConfigFromEnv(process.env);
  if (rerankConfig && toolInterface !== "pyserini-rest-2tool") {
    throw new Error(
      `Reranking needs the pyserini-rest-2tool tool interface; this run uses ${toolInterface}`,
    );
  }
  const rerankClient = rerankConfig ? new RerankWorkerClient(rerankConfig) : undefined;
  const agentContext = rerankConfig
    ? new AgentContextStore(rerankConfig.maxTraceChars ?? RERANK_DEFAULTS.maxTraceChars)
    : undefined;
  const submitNowDelayMs = getSubmitNowDelayMs();
  const submitNowPromptTokens = resolveSubmitNowPromptTokens(process.env);
  const blockRepeatQueries = isRepeatQueryBlockEnabled(process.env);
  const issuedQueries = new Set<string>();
  const failFast = isFailFastEnabled(process.env);
  // Opt-in: without PI_SEARCH_MAX_OUTPUT_TOKENS or PI_SEARCH_SAMPLING_OVERRIDES
  // no handler is registered and provider payloads are exactly what pi built.
  const maxOutputTokens = resolveMaxOutputTokens(process.env);
  const samplingOverrides = resolveSamplingOverrides(process.env);
  if (maxOutputTokens !== undefined || samplingOverrides !== undefined) {
    pi.on("before_provider_request", async (event) => {
      let payload = event.payload;
      if (maxOutputTokens !== undefined) payload = applyMaxOutputTokens(payload, maxOutputTokens);
      if (samplingOverrides !== undefined)
        payload = applySamplingOverrides(payload, samplingOverrides);
      return payload;
    });
  }
  let spillSequence = 0;
  let submitNowTimer: ReturnType<typeof setTimeout> | null = null;
  let submitNowMode = false;
  // Block note for retrieval calls once submit-now is on; names the budget that ran out.
  let submitNowBlockReason = SUBMIT_NOW_BLOCK_REASON;
  let promptSnapshotWritten = false;
  let spillCleanupRegistered = false;

  const cleanupSpillDir = () => {
    backendRuntime.dispose();
    spillDir.cleanup();
  };

  const registerSpillCleanup = () => {
    if (spillCleanupRegistered) return;
    spillCleanupRegistered = true;
    process.once("exit", cleanupSpillDir);
    process.once("SIGINT", cleanupSpillDir);
    process.once("SIGTERM", cleanupSpillDir);
  };

  const nextSpillSequence = (): number => {
    spillSequence += 1;
    return spillSequence;
  };

  const toolDeps = {
    backendRuntime,
    searchStore,
    spillDir,
    nextSpillSequence,
    ...(rerankConfig
      ? {
          rerankClient,
          agentContext,
          globalQuery: resolveGlobalQuery(process.env),
          queryId: process.env.PI_SEARCH_QUERY_ID?.trim() || undefined,
        }
      : {}),
  };
  const pyseriniRestPaginatedRead =
    toolInterface === "pyserini-rest-2tool" &&
    extensionConfig.backend.kind === "pyserini-rest" &&
    extensionConfig.backend.readMode === "paginated";

  registerSpillCleanup();

  function clearSubmitNowTimer() {
    if (submitNowTimer !== null) {
      clearTimeout(submitNowTimer);
      submitNowTimer = null;
    }
  }

  pi.on("before_agent_start", async (event) => {
    const strippedSystemPrompt = stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt);
    if (!promptSnapshotWritten) {
      dumpPromptSnapshot(strippedSystemPrompt, event.prompt);
      promptSnapshotWritten = true;
    }
    if (strippedSystemPrompt === event.systemPrompt) {
      return;
    }
    return { systemPrompt: strippedSystemPrompt };
  });

  pi.on("agent_start", async (_event, ctx) => {
    clearSubmitNowTimer();
    submitNowMode = false;
    if (submitNowDelayMs === null) {
      return;
    }
    submitNowTimer = setTimeout(() => {
      if (submitNowMode || ctx.isIdle()) {
        return;
      }
      submitNowMode = true;
      submitNowBlockReason = SUBMIT_NOW_BLOCK_REASON;
      try {
        console.error(
          `[pi-search] Time budget threshold reached at ${(submitNowDelayMs / 1000).toFixed(1)}s (${Math.round(SUBMIT_NOW_TRIGGER_RATIO * 100)}% of TIMEOUT_SECONDS=${BENCHMARK_TIMEOUT_SECONDS}); queueing submit-now steer and blocking further retrieval tools.`,
        );
        pi.sendUserMessage(SUBMIT_NOW_STEER_MESSAGE, { deliverAs: "steer" });
      } catch (error) {
        console.error(
          `[pi-search] Failed to queue submit-now steer: ${error instanceof Error ? error.message : String(error)}`,
        );
        submitNowMode = false;
      }
    }, submitNowDelayMs);
  });

  if (agentContext) {
    // pi drains agent events before firing tool_call, so the session is
    // synchronized through the assistant message carrying this call: the one
    // moment its thinking and its query are both known. Registered before the
    // submit-now handler; it never blocks a call.
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "search") return;
      try {
        agentContext.record(String(event.toolCallId), ctx.sessionManager.getBranch());
      } catch (error) {
        console.error(
          `[pi-search] Could not read the reasoning trace for this search; it will be ` +
            `reranked without one. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  if (submitNowPromptTokens !== null) {
    // Opt-in (PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS). Fires at the end of an
    // assistant turn that calls tools, before those calls run: pi emits
    // message_end first, then the tool_call hooks, and it delivers queued
    // steers before the next model request. So this turn's retrieval calls are
    // already blocked, and the next request carries the steer. A turn that
    // answers (no tool calls) never triggers it, so a finished trajectory is
    // not reopened.
    pi.on("message_end", async (event) => {
      const message = event.message as {
        role?: string;
        content?: Array<{ type?: string }>;
        usage?: Parameters<typeof contextTokensAfterTurn>[0];
      };
      if (submitNowMode || message.role !== "assistant" || !message.usage) {
        return;
      }
      if (!(message.content ?? []).some((part) => part.type === "toolCall")) {
        return;
      }
      const contextTokens = contextTokensAfterTurn(message.usage);
      if (contextTokens < submitNowPromptTokens) {
        return;
      }
      submitNowMode = true;
      submitNowBlockReason = CONTEXT_SUBMIT_NOW_BLOCK_REASON;
      try {
        console.error(
          `[pi-search] Prompt-size threshold reached: ${contextTokens} tokens after this turn >= PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS=${submitNowPromptTokens}; queueing submit-now steer and blocking further retrieval tools.`,
        );
        pi.sendUserMessage(CONTEXT_SUBMIT_NOW_STEER_MESSAGE, { deliverAs: "steer" });
      } catch (error) {
        console.error(
          `[pi-search] Failed to queue submit-now steer: ${error instanceof Error ? error.message : String(error)}`,
        );
        submitNowMode = false;
      }
    });
  }

  pi.on("tool_call", async (event) => {
    if (!submitNowMode) {
      if (blockRepeatQueries && event.toolName === "search") {
        // Opt-in (PI_SEARCH_BLOCK_REPEAT_QUERIES=1).
        const query = normalizeSearchQuery((event.input as { query?: unknown } | undefined)?.query);
        if (query !== null) {
          if (issuedQueries.has(query)) {
            console.error(
              `[pi-search] Blocking repeated search query ${JSON.stringify(query).slice(0, 300)}.`,
            );
            return { block: true, reason: REPEAT_QUERY_BLOCK_MESSAGE };
          }
          issuedQueries.add(query);
        }
      }
      return;
    }
    if (
      event.toolName === "search" ||
      event.toolName === "read_search_results" ||
      event.toolName === "read_document"
    ) {
      const steer = submitNowBlockReason === SUBMIT_NOW_BLOCK_REASON ? "timeout" : "context-budget";
      console.error(
        `[pi-search] Blocking ${event.toolName} after ${steer} steer; model must submit final answer now.`,
      );
      return { block: true, reason: submitNowBlockReason };
    }
  });

  pi.on("agent_end", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
  });

  pi.on("session_shutdown", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
    cleanupSpillDir();
  });

  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      toolInterface === "pyserini-rest-2tool"
        ? "Search the configured backend and return ranked hits directly. The first argument must be reason, a brief rationale of at most 100 words."
        : "Search the configured pi-search backend using a raw query string. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      toolInterface === "pyserini-rest-2tool"
        ? "Always supply reason first, under 100 words. Use query for a concise lexical query. The tool returns ranked hits directly; inspect promising docids with read_document."
        : "Always supply reason first, under 100 words. Use query for a concise raw search string based on the original wording or one grounded refinement. The tool returns a search_id plus the first page of results.",
    promptGuidelines:
      toolInterface === "pyserini-rest-2tool"
        ? [
            "Always provide reason first. Keep it specific and under 100 words.",
            "Use query as a short raw lexical query string, not a structured object and not raw Lucene syntax.",
            "The search result itself is the visible ranked list; there is no search_id or result-page browsing tool in this condition.",
            ...(isDirectSearchHitsCapped()
              ? []
              : [
                  "Keep hits small by default. Increase hits only when the visible ranking is too shallow for the question.",
                ]),
            "Open promising docids with read_document before answering.",
          ]
        : [
            "Always provide reason first. Keep it specific and under 100 words.",
            "Use query as a short raw lexical query string, not a structured object and not raw Lucene syntax.",
            "Start close to the original wording, then make grounded refinements only after browsing or reading.",
            "If the current ranking looks partially relevant, browse it before rewriting.",
            "After browsing a ranking that surfaces plausible candidates, inspect one with read_document(docid).",
          ],
    parameters:
      toolInterface === "pyserini-rest-2tool"
        ? isDirectSearchHitsCapped()
          ? DirectSearchParamsPinnedSchema
          : DirectSearchParamsSchema
        : PlainSearchParamsSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const run = async () =>
        toolInterface === "pyserini-rest-2tool"
          ? executeDirectSearchTool(params, signal, ctx, toolDeps, toolCallId)
          : executeSearchTool(params, signal, ctx, toolDeps);
      return failFast ? runFailFast(run, "search") : run();
    },
  });

  if (toolInterface === "pi-serini-3tool") {
    pi.registerTool({
      name: "read_search_results",
      label: "Read Search Results",
      description:
        "Read a cached search result set by search_id. Supports offset and limit for paginated browsing of ranked hits, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
      promptSnippet:
        "Always supply reason first, with a brief rationale of at most 100 words. Then read a cached search result set by search_id in paginated ranked-hit chunks using offset and limit.",
      promptGuidelines: [
        "Always provide reason as the first argument. Keep it specific and under 100 words.",
        "Use read_search_results to browse deeper ranks from an existing search result set before rewriting the query.",
        "If the current ranking looks partly relevant, inspect more ranks here rather than issuing another search immediately.",
        "When browse surfaces plausible candidate biographies, open one with read_document(docid).",
      ],
      parameters: ReadSearchResultsParamsSchema,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeReadSearchResultsTool(params, signal, ctx, toolDeps);
      },
    });
  }

  pi.registerTool({
    name: "read_document",
    label: "Read Document",
    description:
      toolInterface === "pyserini-rest-2tool" && !pyseriniRestPaginatedRead
        ? "Fetch a full document by docid from the configured backend. The first argument must be reason, a brief rationale of at most 100 words."
        : "Read a retrieved document by docid. Supports offset and limit for paginated line-based reading, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      toolInterface === "pyserini-rest-2tool" && !pyseriniRestPaginatedRead
        ? "Always supply reason first, with a brief rationale of at most 100 words. Then fetch the full document by docid; no offset or limit is needed."
        : "Always supply reason first, with a brief rationale of at most 100 words. Then read a retrieved document by docid in paginated line-based chunks using offset and limit.",
    promptGuidelines:
      toolInterface === "pyserini-rest-2tool" && !pyseriniRestPaginatedRead
        ? [
            "Always provide reason as the first argument. Keep it specific and under 100 words.",
            "Use read_document to verify evidence from a specific docid before answering.",
            "Do not provide offset or limit; this tool fetches the full document returned by the backend.",
          ]
        : [
            "Always provide reason as the first argument. Keep it specific and under 100 words.",
            "Use read_document to verify evidence from a specific docid before answering.",
            "Start with offset=1 and a moderate limit when first reading a document.",
            "If a document is truncated and still looks relevant, continue reading the same document with the suggested next offset before launching many new searches.",
          ],
    parameters:
      toolInterface === "pyserini-rest-2tool" && !pyseriniRestPaginatedRead
        ? DirectReadDocumentParamsSchema
        : ReadDocumentParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const run = async () =>
        toolInterface === "pyserini-rest-2tool" && !pyseriniRestPaginatedRead
          ? executeDirectReadDocumentTool(params, signal, ctx, toolDeps)
          : executeReadDocumentTool(params, signal, ctx, toolDeps);
      return failFast ? runFailFast(run, "read_document") : run();
    },
  });
}

/** Exit status of the pi process when a search-side failure aborts the run (PI_SEARCH_FAIL_FAST=1). */
export const PI_SEARCH_FATAL_EXIT_CODE = 75;

/**
 * Fail-fast (opt-in): PI_SEARCH_FAIL_FAST=1 ends the run when retrieval or
 * reranking fails, instead of handing the model a tool error.
 *
 * Both have already gone through their own bounded retries. A tool error lets
 * the trajectory continue without evidence and still be scored; with this
 * flag the pi process prints a marker line and exits, and the benchmark
 * runner records the run as failed with that reason (failure.kind). Argument
 * validation errors are the model's own mistakes and still come back to it as
 * tool errors. Unset = failures reach the model as before.
 */
export function isFailFastEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SEARCH_FAIL_FAST === "1";
}

async function runFailFast<T>(run: () => Promise<T>, tool: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    abortOnFatalPiSearchError(error, tool);
    throw error;
  }
}

function abortOnFatalPiSearchError(error: unknown, tool: string): void {
  const kind =
    error instanceof PiSearchRerankError
      ? "rerank_error"
      : error instanceof PiSearchBackendUnavailableError ||
          error instanceof PiSearchBackendExecutionError
        ? "retrieval_error"
        : null;
  if (!kind) return;
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 500);
  writeSync(2, `[pi-search] FATAL kind=${kind} tool=${tool} message=${message}\n`);
  process.exit(PI_SEARCH_FATAL_EXIT_CODE);
}

export default function (pi: ExtensionAPI) {
  registerPiSearchExtension(pi);
}
