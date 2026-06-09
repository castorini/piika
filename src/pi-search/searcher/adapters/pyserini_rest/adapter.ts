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
    let response: Response;
    try {
      response = await fetch(url, {
        headers: getAuthHeaders(this.config),
        signal,
      });
    } catch (error) {
      throw new PiSearchBackendUnavailableError(
        this.capabilities.backendId,
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
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
}
