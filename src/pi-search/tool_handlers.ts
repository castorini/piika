import type { PiSearchBackendRuntime } from "./searcher/runtime";
import type { AgentContextStore } from "./agent_context";
import type { SearchBackendSearchHit } from "./searcher/contract/types";
import { PiSearchRerankError, type RerankWorkerClient } from "./rerank/client";
import { PiSearchInvalidToolArgumentsError, PiSearchToolExecutionError } from "./protocol/errors";
import type {
  DirectReadDocumentParams,
  DirectSearchParams,
  PlainSearchParams,
  ReadDocumentParams,
  ReadSearchResultsParams,
} from "./protocol/schemas";
import {
  buildReadSpillFileName,
  buildSearchSpillFileName,
  type ManagedTempSpillDir,
  truncateReadDocumentOutput,
  truncateSearchOutput,
} from "./spill";
import {
  buildSearchPage,
  formatSearchPageText,
  normalizePositiveInteger,
  SearchSessionStore,
} from "./search_cache";
import type {
  ReadDocumentDetails,
  ReadSearchResultsDetails,
  SearchDetails,
  ToolTimingBreakdown,
} from "./tool_types";

const SEARCH_QUERY_MODE = "plain";
const SEARCH_CACHE_K = 1000;
const SEARCH_FIRST_PAGE_LIMIT = 5;
const SEARCH_RESULTS_DEFAULT_LIMIT = 10;
const DIRECT_SEARCH_DEFAULT_LIMIT = 5;
const DIRECT_SEARCH_MAX_LIMIT = 100;

type SpillSequence = () => number;
type ToolExecutionContext = { cwd: string };

type ToolHandlerDeps = {
  backendRuntime: PiSearchBackendRuntime;
  searchStore: SearchSessionStore;
  spillDir: ManagedTempSpillDir;
  nextSpillSequence: SpillSequence;
  /** Absent when reranking is off, which leaves the search path untouched. */
  rerankClient?: RerankWorkerClient;
  /** Reasoning traces captured at tool_call, keyed by tool call id. */
  agentContext?: AgentContextStore;
  /** The question that opened the session. */
  globalQuery?: string;
  /** Benchmark query id, forwarded so worker logs line up with run artifacts. */
  queryId?: string;
};

function formatReadDocumentText(parsed: {
  docid: string;
  totalUnits?: number;
  returnedOffsetStart?: number;
  returnedOffsetEnd?: number;
  text: string;
  truncated: boolean;
  nextOffset?: number;
  limit: number;
}): string {
  const totalLines = parsed.totalUnits ?? 0;
  const returnedLineStart = parsed.returnedOffsetStart ?? 0;
  const returnedLineEnd = parsed.returnedOffsetEnd ?? 0;
  const lines = [
    `[docid=${parsed.docid} lines ${returnedLineStart}-${returnedLineEnd} of ${totalLines}]`,
    "",
    parsed.text,
  ];

  if (parsed.truncated && parsed.nextOffset) {
    lines.push("");
    lines.push(
      `[Document truncated. Continue with read_document({"docid":"${parsed.docid}","offset":${parsed.nextOffset},"limit":${parsed.limit}}).]`,
    );
  }

  return lines.join("\n").trim();
}

function formatDirectSearchText(args: {
  rawQuery: string;
  limit: number;
  hits: Array<{ docid: string; score?: number; title?: string | null; snippet?: string }>;
}): string {
  if (args.hits.length === 0) {
    return [`No hits returned.`, `Plain query: ${JSON.stringify(args.rawQuery)}`].join("\n");
  }

  const lines = [
    `Returned ${args.hits.length} hits from the Pyserini REST ranking.`,
    `Plain query: ${JSON.stringify(args.rawQuery)}`,
    `Requested hits: ${args.limit}`,
    "",
  ];
  for (const [index, hit] of args.hits.entries()) {
    const scoreText = typeof hit.score === "number" ? ` score=${hit.score.toFixed(4)}` : "";
    lines.push(`${index + 1}. docid=${hit.docid}${scoreText}`);
    if (hit.title) {
      lines.push(`   Title: ${hit.title}`);
    }
    if (hit.snippet) {
      lines.push(`   Excerpt: ${hit.snippet}`);
    } else {
      lines.push("   Excerpt: (No snippet available. Use read_document(docid) to inspect.)");
    }
    lines.push("");
  }
  lines.push("Use read_document(docid) to inspect a specific document before answering.");
  return lines.join("\n").trim();
}

function formatDirectReadDocumentText(args: {
  docid: string;
  title?: string | null;
  text: string;
}) {
  const lines = [`[docid=${args.docid} full document]`];
  if (args.title) {
    lines.push(`[title=${args.title}]`);
  }
  lines.push("", args.text);
  return lines.join("\n").trim();
}

function normalizeDirectSearchLimit(value: number | undefined): number {
  const parsed = normalizePositiveInteger(value, DIRECT_SEARCH_DEFAULT_LIMIT);
  return Math.min(parsed, DIRECT_SEARCH_MAX_LIMIT);
}

export async function executeSearchTool(
  params: PlainSearchParams,
  signal: AbortSignal | undefined,
  ctx: ToolExecutionContext,
  deps: ToolHandlerDeps,
) {
  const backend = deps.backendRuntime.getBackend(ctx.cwd);
  const rawQuery = String(params.query ?? "").trim();
  if (!rawQuery) {
    throw new PiSearchInvalidToolArgumentsError(
      "search arguments",
      "query must be a non-empty string.",
    );
  }
  const queryMode = SEARCH_QUERY_MODE;
  const response = await backend.search(
    {
      query: rawQuery,
      limit: SEARCH_CACHE_K,
    },
    signal,
  );

  const searchTiming: ToolTimingBreakdown = {
    searchRpcMs: response.timingMs?.request,
    serverInitMs: response.timingMs?.backendInit,
    serverUptimeMs: response.timingMs?.backendUptime,
  };
  const cached = deps.searchStore.createSearch(rawQuery, queryMode, response.hits);
  const page = buildSearchPage(cached, 1, SEARCH_FIRST_PAGE_LIMIT, searchTiming);
  const fullPageJson = JSON.stringify(page, null, 2);
  const rendered = truncateSearchOutput(
    deps.spillDir,
    buildSearchSpillFileName(page, deps.nextSpillSequence()),
    formatSearchPageText(page),
    fullPageJson,
  );

  return {
    content: [{ type: "text" as const, text: rendered.text }],
    details: {
      searchId: cached.searchId,
      rawQuery,
      queryMode: cached.queryMode,
      k: SEARCH_CACHE_K,
      totalCached: cached.results.length,
      returnedRankStart: page.returnedRankStart,
      returnedRankEnd: page.returnedRankEnd,
      nextOffset: page.nextOffset,
      retrievedDocids: cached.results.map((item) => item.docid),
      previewedDocids: page.results.map((item) => item.docid),
      timingMs: page.timingMs,
      truncation: rendered.truncation,
      fullOutputPath: rendered.fullOutputPath,
    } satisfies SearchDetails,
  };
}

export async function executeDirectSearchTool(
  params: DirectSearchParams,
  signal: AbortSignal | undefined,
  ctx: ToolExecutionContext,
  deps: ToolHandlerDeps,
  toolCallId?: string,
) {
  const backend = deps.backendRuntime.getBackend(ctx.cwd);
  const rawQuery = String(params.query ?? "").trim();
  if (!rawQuery) {
    throw new PiSearchInvalidToolArgumentsError(
      "search arguments",
      "query must be a non-empty string.",
    );
  }
  const limit = normalizeDirectSearchLimit(params.hits);
  // With a reranker, the first stage is asked for a deeper pool and the
  // reranker decides which `limit` of it the agent sees. Without one, the
  // first stage is asked for exactly what the agent asked for.
  const rerankClient = deps.rerankClient;
  const firstStageLimit = rerankClient ? Math.max(limit, rerankClient.configuredDepth) : limit;
  const response = await backend.search(
    {
      query: rawQuery,
      limit: firstStageLimit,
    },
    signal,
  );
  const reranked = rerankClient
    ? await rerankDirectSearchHits(
        rerankClient,
        response.hits,
        rawQuery,
        limit,
        deps,
        toolCallId,
        signal,
      )
    : undefined;
  const hits = reranked ? reranked.hits : response.hits;

  const renderedText = formatDirectSearchText({
    rawQuery,
    limit,
    hits,
  });
  const rendered = truncateSearchOutput(
    deps.spillDir,
    `direct_search_${deps.nextSpillSequence()}.txt`,
    renderedText,
    JSON.stringify({ rawQuery, limit, hits }, null, 2),
  );
  const docids = hits.map((hit) => hit.docid);
  return {
    content: [{ type: "text" as const, text: rendered.text }],
    details: {
      toolInterface: "pyserini-rest-2tool",
      rawQuery,
      queryMode: SEARCH_QUERY_MODE,
      k: limit,
      ...(reranked ? { firstStageK: firstStageLimit, rerank: reranked.details } : {}),
      returnedRankStart: hits.length > 0 ? 1 : 0,
      returnedRankEnd: hits.length,
      retrievedDocids: docids,
      previewedDocids: docids,
      timingMs: {
        searchRpcMs: response.timingMs?.request,
        serverInitMs: response.timingMs?.backendInit,
        serverUptimeMs: response.timingMs?.backendUptime,
      },
      truncation: rendered.truncation,
      fullOutputPath: rendered.fullOutputPath,
    },
  };
}

type DirectSearchHit = SearchBackendSearchHit;

/**
 * The first-stage pool in the rerank worker's order, cut to `limit`, with the
 * rerank details recorded on the tool result. The worker must rank the
 * candidates it was given: a list that does not fill the visible slots is a
 * reranker failure like any other, so it throws rather than showing
 * first-stage order or fewer hits.
 */
async function rerankDirectSearchHits(
  rerankClient: RerankWorkerClient,
  pool: DirectSearchHit[],
  rawQuery: string,
  limit: number,
  deps: ToolHandlerDeps,
  toolCallId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ hits: DirectSearchHit[]; details: Record<string, unknown> }> {
  const reasoning = toolCallId ? (deps.agentContext?.take(toolCallId) ?? "") : "";
  const outcome = await rerankClient.rerank(
    deps.queryId ?? "",
    rawQuery,
    pool.map((hit) => ({ docid: hit.docid, score: hit.score, text: hit.snippet ?? "" })),
    limit,
    { globalQuery: deps.globalQuery, reasoning },
    signal,
  );
  const byDocid = new Map(pool.map((hit) => [hit.docid, hit]));
  const reordered = outcome.docids
    .map((docid) => byDocid.get(docid))
    .filter((hit): hit is DirectSearchHit => Boolean(hit));
  const expected = Math.min(limit, pool.length);
  if (reordered.length < expected) {
    throw new PiSearchRerankError(
      `rerank worker returned ${reordered.length} resolvable docids for ${expected} result slots`,
    );
  }
  return {
    hits: reordered.slice(0, limit),
    details: {
      applied: !outcome.failed,
      failed: outcome.failed,
      depth: outcome.depth,
      contextFields: outcome.contextFields,
      elapsedMs: Number(outcome.elapsedMs.toFixed(1)),
      usage: outcome.usage,
    },
  };
}

export async function executeReadSearchResultsTool(
  params: ReadSearchResultsParams,
  _signal: AbortSignal | undefined,
  _ctx: ToolExecutionContext,
  deps: ToolHandlerDeps,
) {
  const offset = normalizePositiveInteger(params.offset, SEARCH_FIRST_PAGE_LIMIT + 1);
  const limit = normalizePositiveInteger(params.limit, SEARCH_RESULTS_DEFAULT_LIMIT);
  const cached = deps.searchStore.getSearch(params.search_id);
  if (!cached) {
    throw new PiSearchInvalidToolArgumentsError(
      "read_search_results arguments",
      `search_id '${params.search_id}' is unknown. Call search(...) first to create a result set.`,
    );
  }

  const page = buildSearchPage(cached, offset, limit);
  const fullPageJson = JSON.stringify(page, null, 2);
  const rendered = truncateSearchOutput(
    deps.spillDir,
    buildSearchSpillFileName(page, deps.nextSpillSequence()),
    formatSearchPageText(page),
    fullPageJson,
  );

  return {
    content: [{ type: "text" as const, text: rendered.text }],
    details: {
      searchId: cached.searchId,
      rawQuery: cached.rawQuery,
      queryMode: cached.queryMode,
      totalCached: cached.results.length,
      offset,
      limit,
      returnedRankStart: page.returnedRankStart,
      returnedRankEnd: page.returnedRankEnd,
      nextOffset: page.nextOffset,
      retrievedDocids: page.results.map((item) => item.docid),
      previewedDocids: page.results.map((item) => item.docid),
      timingMs: page.timingMs,
      truncation: rendered.truncation,
      fullOutputPath: rendered.fullOutputPath,
    } satisfies ReadSearchResultsDetails,
  };
}

export async function executeReadDocumentTool(
  params: ReadDocumentParams,
  signal: AbortSignal | undefined,
  ctx: ToolExecutionContext,
  deps: ToolHandlerDeps,
) {
  const backend = deps.backendRuntime.getBackend(ctx.cwd);
  const offset = normalizePositiveInteger(params.offset, 1);
  const limit = normalizePositiveInteger(params.limit, 200);
  const response = await backend.readDocument(
    {
      docid: params.docid,
      offset,
      limit,
    },
    signal,
  );

  const readTiming: ToolTimingBreakdown = {
    readDocumentRpcMs: response.timingMs?.request,
    serverInitMs: response.timingMs?.backendInit,
    serverUptimeMs: response.timingMs?.backendUptime,
  };
  if (!response.found) {
    throw new PiSearchToolExecutionError(
      "read_document",
      `docid '${params.docid}' was not found. Choose a docid returned by search(...) or read_search_results(...).`,
    );
  }

  const formatted = formatReadDocumentText({
    docid: response.docid,
    totalUnits: response.totalUnits,
    returnedOffsetStart: response.returnedOffsetStart,
    returnedOffsetEnd: response.returnedOffsetEnd,
    text: response.text,
    truncated: response.truncated,
    nextOffset: response.nextOffset,
    limit: response.limit,
  });
  const spillPayload = {
    docid: response.docid,
    offset: response.offset,
    limit: response.limit,
    returned_line_start: response.returnedOffsetStart,
    returned_line_end: response.returnedOffsetEnd,
  };
  const rendered = truncateReadDocumentOutput(
    deps.spillDir,
    buildReadSpillFileName(spillPayload, deps.nextSpillSequence()),
    formatted,
    formatted,
    {
      ...spillPayload,
      truncated: response.truncated,
      next_offset: response.nextOffset,
    },
  );

  return {
    content: [{ type: "text" as const, text: rendered.text }],
    details: {
      docid: params.docid,
      offset,
      limit,
      totalLines: response.totalUnits ?? 0,
      returnedLineStart: response.returnedOffsetStart ?? 0,
      returnedLineEnd: response.returnedOffsetEnd ?? 0,
      truncated: response.truncated,
      nextOffset: response.nextOffset,
      timingMs: readTiming,
      outputTruncation: rendered.truncation,
      fullOutputPath: rendered.fullOutputPath,
    } satisfies ReadDocumentDetails,
  };
}

export async function executeDirectReadDocumentTool(
  params: DirectReadDocumentParams,
  signal: AbortSignal | undefined,
  ctx: ToolExecutionContext,
  deps: ToolHandlerDeps,
) {
  const backend = deps.backendRuntime.getBackend(ctx.cwd);
  const response = await backend.readDocument({ docid: params.docid }, signal);

  const readTiming: ToolTimingBreakdown = {
    readDocumentRpcMs: response.timingMs?.request,
    serverInitMs: response.timingMs?.backendInit,
    serverUptimeMs: response.timingMs?.backendUptime,
  };
  if (!response.found) {
    throw new PiSearchToolExecutionError(
      "read_document",
      `docid '${params.docid}' was not found. Choose a docid returned by search(...).`,
    );
  }

  const formatted = formatDirectReadDocumentText({
    docid: response.docid,
    title: response.title,
    text: response.text,
  });
  const lineCount =
    response.totalUnits ?? (response.text ? response.text.split(/\r?\n/).length : 0);
  const rendered = truncateReadDocumentOutput(
    deps.spillDir,
    buildReadSpillFileName(
      {
        docid: response.docid,
        offset: 1,
        returned_line_start: lineCount > 0 ? 1 : undefined,
        returned_line_end: lineCount > 0 ? lineCount : undefined,
      },
      deps.nextSpillSequence(),
    ),
    formatted,
    formatted,
    {
      docid: response.docid,
      offset: 1,
      returned_line_start: lineCount > 0 ? 1 : undefined,
      returned_line_end: lineCount > 0 ? lineCount : undefined,
      truncated: false,
    },
  );

  return {
    content: [{ type: "text" as const, text: rendered.text }],
    details: {
      toolInterface: "pyserini-rest-2tool",
      docid: params.docid,
      totalLines: lineCount,
      truncated: false,
      timingMs: readTiming,
      outputTruncation: rendered.truncation,
      fullOutputPath: rendered.fullOutputPath,
    },
  };
}
