import {
  PiSearchBackendExecutionError,
  PiSearchBackendUnavailableError,
} from "../../contract/errors";
import type { PiSearchBackend } from "../../contract/interface";
import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchHit,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";
import type { PiSearchExtensionConfig } from "../../../config";

type PyseriniRestBackendConfig = Extract<
  PiSearchExtensionConfig["backend"],
  { kind: "pyserini-rest" }
>;

type PyseriniSearchCandidate = {
  docid?: unknown;
  score?: unknown;
  rank?: unknown;
  doc?: unknown;
};

type PyseriniSearchResponse = {
  candidates?: unknown;
};

type PyseriniDocResponse = {
  docid?: unknown;
  doc?: unknown;
};

const DEFAULT_SEARCH_MAX_DOC_LENGTH = 500;
const MAX_FETCH_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 15_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function encodeIndexPath(index: string): string {
  return index
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getAuthHeaders(config: PyseriniRestBackendConfig): Record<string, string> {
  const tokenEnv = config.tokenEnv?.trim();
  const token = tokenEnv ? process.env[tokenEnv]?.trim() : undefined;
  return token ? { authorization: `Bearer ${token}` } : {};
}

function getRetryDelayMs(response: Response, failedAttempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(retryAt - Date.now(), 0), MAX_RETRY_DELAY_MS);
    }
  }
  const exponentialDelay = 1_000 * 2 ** failedAttempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY_MS);
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Request aborted"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function stringifyDocValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const primaryText = ["text", "contents", "content", "body"]
      .map((key) => record[key])
      .find((item): item is string => typeof item === "string");
    if (primaryText) {
      return primaryText;
    }
  }
  return JSON.stringify(value);
}

function extractTitle(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const title = (value as Record<string, unknown>).title;
  return typeof title === "string" ? title : undefined;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function sliceDocumentLines(text: string, offset: number, limit: number) {
  const lines = text.split(/\r?\n/);
  const startIndex = Math.min(Math.max(offset - 1, 0), lines.length);
  const endIndex = Math.min(startIndex + limit, lines.length);
  return {
    text: lines.slice(startIndex, endIndex).join("\n"),
    totalUnits: lines.length,
    returnedOffsetStart: lines.length > 0 ? startIndex + 1 : 0,
    returnedOffsetEnd: endIndex,
    truncated: endIndex < lines.length,
    nextOffset: endIndex < lines.length ? endIndex + 1 : undefined,
  };
}

function truncateSnippet(
  text: string,
  maxChars = DEFAULT_SEARCH_MAX_DOC_LENGTH,
): {
  snippet: string;
  truncated: boolean;
} {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return { snippet: compact, truncated: false };
  }
  return { snippet: `${compact.slice(0, maxChars).trimEnd()}...`, truncated: true };
}

export class PyseriniRestSearchBackend implements PiSearchBackend {
  readonly capabilities: SearchBackendCapabilities;
  private readonly baseUrl: string;

  constructor(private readonly config: PyseriniRestBackendConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.capabilities = {
      backendId: "pyserini-rest",
      supportsScore: true,
      supportsSnippets: true,
      supportsExactTotalHits: false,
    };
  }

  async search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const startedAt = performance.now();
    const url = new URL(`${this.baseUrl}/v1/${encodeIndexPath(this.config.index)}/search`);
    url.searchParams.set("query", request.query);
    url.searchParams.set("hits", String(request.limit));
    url.searchParams.set(
      "max_doc_length",
      String(this.config.searchMaxDocLength ?? DEFAULT_SEARCH_MAX_DOC_LENGTH),
    );

    const parsed = (await this.fetchJson("search", url, signal)) as PyseriniSearchResponse;
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const hits: SearchBackendSearchHit[] = candidates.flatMap((raw) => {
      const candidate = raw as PyseriniSearchCandidate;
      if (typeof candidate.docid !== "string" || candidate.docid.trim().length === 0) {
        return [];
      }

      const docText = stringifyDocValue(candidate.doc) ?? "";
      const preview = truncateSnippet(
        docText,
        this.config.searchMaxDocLength ?? DEFAULT_SEARCH_MAX_DOC_LENGTH,
      );
      return [
        {
          docid: candidate.docid,
          score: typeof candidate.score === "number" ? candidate.score : undefined,
          title: extractTitle(candidate.doc),
          snippet: preview.snippet || undefined,
          snippetTruncated: preview.truncated,
          metadata: typeof candidate.rank === "number" ? { rank: candidate.rank } : undefined,
        },
      ];
    });

    return {
      hits,
      hasMore: hits.length >= request.limit,
      timingMs: {
        request: performance.now() - startedAt,
      },
    };
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    const startedAt = performance.now();
    const readMode = this.config.readMode ?? "full";
    if (readMode === "full" && (request.offset !== undefined || request.limit !== undefined)) {
      throw new PiSearchBackendExecutionError(
        this.capabilities.backendId,
        "readDocument",
        "Pyserini REST get-document returns full documents by default; paginated offset/limit reads require readMode='paginated'.",
      );
    }
    const url = new URL(
      `${this.baseUrl}/v1/${encodeIndexPath(this.config.index)}/doc/${encodeURIComponent(
        request.docid,
      )}`,
    );

    const parsed = (await this.fetchJson("readDocument", url, signal, {
      notFoundAsUndefined: true,
    })) as PyseriniDocResponse | undefined;
    const timingMs = { request: performance.now() - startedAt };

    if (!parsed) {
      return {
        found: false,
        docid: request.docid,
        timingMs,
      };
    }

    const text = stringifyDocValue(parsed.doc);
    if (text === undefined) {
      return {
        found: false,
        docid: typeof parsed.docid === "string" ? parsed.docid : request.docid,
        timingMs,
      };
    }

    const lineCount = countLines(text);
    if (readMode === "paginated") {
      const offset = request.offset ?? 1;
      const limit = request.limit ?? 200;
      const sliced = sliceDocumentLines(text, offset, limit);
      return {
        found: true,
        docid: typeof parsed.docid === "string" ? parsed.docid : request.docid,
        text: sliced.text,
        title: extractTitle(parsed.doc),
        offset,
        limit,
        totalUnits: sliced.totalUnits,
        returnedOffsetStart: sliced.returnedOffsetStart,
        returnedOffsetEnd: sliced.returnedOffsetEnd,
        truncated: sliced.truncated,
        nextOffset: sliced.nextOffset,
        timingMs,
      };
    }

    return {
      found: true,
      docid: typeof parsed.docid === "string" ? parsed.docid : request.docid,
      text,
      title: extractTitle(parsed.doc),
      offset: 1,
      limit: lineCount,
      totalUnits: lineCount,
      returnedOffsetStart: lineCount > 0 ? 1 : undefined,
      returnedOffsetEnd: lineCount > 0 ? lineCount : undefined,
      truncated: false,
      timingMs,
    };
  }

  private async fetchJson(
    operation: "search" | "readDocument",
    url: URL,
    signal?: AbortSignal,
    options: { notFoundAsUndefined?: boolean } = {},
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: getAuthHeaders(this.config),
          signal,
        });
      } catch (error) {
        if (attempt + 1 < MAX_FETCH_ATTEMPTS && !signal?.aborted) {
          await waitForRetry(Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS), signal);
          continue;
        }
        throw new PiSearchBackendUnavailableError(
          this.capabilities.backendId,
          error instanceof Error ? error.message : String(error),
        );
      }

      const text = await response.text();
      if (
        RETRYABLE_HTTP_STATUSES.has(response.status) &&
        attempt + 1 < MAX_FETCH_ATTEMPTS &&
        !signal?.aborted
      ) {
        await waitForRetry(getRetryDelayMs(response, attempt), signal);
        continue;
      }
      if (response.status === 404 && options.notFoundAsUndefined) {
        return undefined;
      }
      if (!response.ok) {
        throw new PiSearchBackendExecutionError(
          this.capabilities.backendId,
          operation,
          `HTTP ${response.status}: ${text}`,
        );
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new PiSearchBackendExecutionError(
          this.capabilities.backendId,
          operation,
          `Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new PiSearchBackendUnavailableError(
      this.capabilities.backendId,
      `${operation} exhausted ${MAX_FETCH_ATTEMPTS} attempts`,
    );
  }
}
