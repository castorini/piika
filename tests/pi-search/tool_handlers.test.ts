import assert from "node:assert/strict";
import test from "node:test";

import type { PiSearchBackend } from "../../src/pi-search/searcher/contract/interface";
import { buildMockExtensionConfig } from "../../src/pi-search/config";
import { PiSearchBackendRuntime } from "../../src/pi-search/searcher/runtime";
import { SearchSessionStore } from "../../src/pi-search/search_cache";
import { ManagedTempSpillDir } from "../../src/pi-search/spill";
import {
  executeDirectReadDocumentTool,
  executeDirectSearchTool,
  executeReadDocumentTool,
  executeReadSearchResultsTool,
  executeSearchTool,
} from "../../src/pi-search/tool_handlers";

type MockBackend = PiSearchBackend;

function createDeps(backend: MockBackend) {
  const spillDir = new ManagedTempSpillDir("pi-search-extension-test-");
  let spillSequence = 0;
  return {
    deps: {
      backendRuntime: {
        getBackend: () => backend,
        dispose: () => {},
      } as unknown as PiSearchBackendRuntime,
      searchStore: new SearchSessionStore(),
      spillDir,
      nextSpillSequence: () => {
        spillSequence += 1;
        return spillSequence;
      },
    },
    cleanup: () => spillDir.cleanup(),
  };
}

function createRuntimeDeps() {
  const spillDir = new ManagedTempSpillDir("pi-search-extension-test-");
  let spillSequence = 0;
  return {
    deps: {
      backendRuntime: new PiSearchBackendRuntime(
        buildMockExtensionConfig({
          documents: [
            {
              docid: "doc-1",
              title: "Ada Lovelace",
              snippet: "Ada wrote about the analytical engine.",
              text: [
                "Ada Lovelace wrote notes on the analytical engine.",
                "She is often described as an early computer pioneer.",
                "This line provides extra context.",
              ].join("\n"),
            },
            {
              docid: "doc-2",
              title: "Charles Babbage",
              snippet: "Babbage designed the analytical engine.",
              text: [
                "Charles Babbage designed mechanical computing devices.",
                "The analytical engine appears in many histories of computing.",
              ].join("\n"),
            },
          ],
        }),
      ),
      searchStore: new SearchSessionStore(),
      spillDir,
      nextSpillSequence: () => {
        spillSequence += 1;
        return spillSequence;
      },
    },
    cleanup: () => spillDir.cleanup(),
  };
}

void test("search rejects empty query with agent-repair-friendly argument feedback", async () => {
  const { deps, cleanup } = createDeps({
    capabilities: {
      backendId: "mock",
      supportsScore: true,
      supportsSnippets: false,
      supportsExactTotalHits: false,
    },
    search: async () => {
      throw new Error("should not be called");
    },
    readDocument: async () => {
      throw new Error("should not be called");
    },
  });

  await assert.rejects(
    () =>
      executeSearchTool({ reason: "need more clues", query: "   " }, undefined, { cwd: "." }, deps),
    /Invalid search arguments: query must be a non-empty string\./,
  );

  cleanup();
});

void test("read_search_results rejects unknown search_id with repair guidance", async () => {
  const { deps, cleanup } = createDeps({
    capabilities: {
      backendId: "mock",
      supportsScore: true,
      supportsSnippets: false,
      supportsExactTotalHits: false,
    },
    search: async () => {
      throw new Error("should not be called");
    },
    readDocument: async () => {
      throw new Error("should not be called");
    },
  });

  await assert.rejects(
    () =>
      executeReadSearchResultsTool(
        { reason: "browse deeper", search_id: "missing", offset: 6, limit: 10 },
        undefined,
        { cwd: "." },
        deps,
      ),
    /Invalid read_search_results arguments: search_id 'missing' is unknown\. Call search\(\.\.\.\) first to create a result set\./,
  );

  cleanup();
});

void test("read_document reports missing docids as tool execution failures instead of generic errors", async () => {
  const { deps, cleanup } = createDeps({
    capabilities: {
      backendId: "mock",
      supportsScore: true,
      supportsSnippets: false,
      supportsExactTotalHits: false,
    },
    search: async () => {
      throw new Error("should not be called");
    },
    readDocument: async () => ({
      found: false,
      docid: "doc-404",
      timingMs: { request: 1 },
    }),
  });

  await assert.rejects(
    () =>
      executeReadDocumentTool(
        { reason: "verify evidence", docid: "doc-404", offset: 1, limit: 20 },
        undefined,
        { cwd: "." },
        deps,
      ),
    /read_document failed: docid 'doc-404' was not found\. Choose a docid returned by search\(\.\.\.\) or read_search_results\(\.\.\.\)\./,
  );

  cleanup();
});

void test("mock adapter can power search and browse through the shared pi-search contract", async () => {
  const { deps, cleanup } = createRuntimeDeps();

  const searchResult = await executeSearchTool(
    { reason: "find analytical engine pioneers", query: "analytical engine ada" },
    undefined,
    { cwd: "." },
    deps,
  );

  assert.match(searchResult.content[0].text, /docid=doc-1/);
  assert.match(searchResult.content[0].text, /Title: Ada Lovelace/);
  assert.match(searchResult.content[0].text, /Excerpt: Ada wrote about the analytical engine\./);
  assert.equal(searchResult.details.retrievedDocids[0], "doc-1");

  const browseResult = await executeReadSearchResultsTool(
    {
      reason: "inspect same cached ranking",
      search_id: searchResult.details.searchId,
      offset: 1,
      limit: 2,
    },
    undefined,
    { cwd: "." },
    deps,
  );

  assert.match(browseResult.content[0].text, /search_id=/);
  assert.deepEqual(browseResult.details.retrievedDocids, ["doc-1", "doc-2"]);

  cleanup();
});

void test("direct search returns visible docids without creating a search_id browse dependency", async () => {
  const { deps, cleanup } = createRuntimeDeps();

  const searchResult = await executeDirectSearchTool(
    { reason: "direct Pyserini search", query: "analytical engine ada", hits: 2 },
    undefined,
    { cwd: "." },
    deps,
  );

  assert.match(searchResult.content[0].text, /Returned 2 hits from the Pyserini REST ranking/);
  assert.doesNotMatch(searchResult.content[0].text, /search_id=/);
  assert.deepEqual(searchResult.details.retrievedDocids, ["doc-1", "doc-2"]);
  assert.deepEqual(searchResult.details.previewedDocids, ["doc-1", "doc-2"]);
  assert.equal(searchResult.details.toolInterface, "pyserini-rest-2tool");

  cleanup();
});

void test("direct read_document returns a full document without continuation guidance", async () => {
  const { deps, cleanup } = createRuntimeDeps();

  const result = await executeDirectReadDocumentTool(
    { reason: "verify full document", docid: "doc-1" },
    undefined,
    { cwd: "." },
    deps,
  );

  assert.match(result.content[0].text, /docid=doc-1 full document/);
  assert.match(result.content[0].text, /This line provides extra context\./);
  assert.doesNotMatch(result.content[0].text, /Continue with read_document/);
  assert.equal(result.details.docid, "doc-1");
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.toolInterface, "pyserini-rest-2tool");

  cleanup();
});

void test("mock adapter can power continuable read_document semantics through the shared contract", async () => {
  const { deps, cleanup } = createRuntimeDeps();

  const result = await executeReadDocumentTool(
    { reason: "verify details", docid: "doc-1", offset: 1, limit: 2 },
    undefined,
    { cwd: "." },
    deps,
  );

  assert.match(result.content[0].text, /docid=doc-1 lines 1-2 of 3/);
  assert.match(result.content[0].text, /Continue with read_document/);
  assert.equal(result.details.docid, "doc-1");
  assert.equal(result.details.returnedLineStart, 1);
  assert.equal(result.details.returnedLineEnd, 2);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.nextOffset, 3);

  cleanup();
});

function fakeRerankClient(
  docids: (requested: string[]) => string[],
  seen: Record<string, unknown>[],
) {
  return {
    configuredDepth: 100,
    async rerank(
      qid: string,
      query: string,
      candidates: { docid: string }[],
      topK: number,
      context: { globalQuery?: string; reasoning?: string },
    ) {
      seen.push({ qid, query, topK, context, candidates: candidates.map((c) => c.docid) });
      return {
        docids: docids(candidates.map((c) => c.docid)),
        usage: { promptTokens: 10, completionTokens: 2, calls: 2 },
        contextFields: ["global_query", "reasoning"],
        depth: candidates.length,
        failed: false,
        elapsedMs: 1,
      };
    },
  };
}

void test("direct search with a reranker shows the worker's order and forwards the agent context", async () => {
  const { deps, cleanup } = createRuntimeDeps();
  const seen: Record<string, unknown>[] = [];
  const traces = new Map([["call-1", "I should look for the engine designer."]]);
  const result = await executeDirectSearchTool(
    { reason: "rerank", query: "analytical engine", hits: 2 },
    undefined,
    { cwd: "." },
    {
      ...deps,
      rerankClient: fakeRerankClient((ids) => [...ids].reverse(), seen) as never,
      agentContext: { take: (id: string) => traces.get(id) ?? "" } as never,
      globalQuery: "Who designed the analytical engine?",
      queryId: "q7",
    },
    "call-1",
  );
  assert.deepEqual(result.details.retrievedDocids, ["doc-2", "doc-1"]);
  assert.equal((result.details.rerank as { applied: boolean }).applied, true);
  assert.deepEqual(seen[0].context, {
    globalQuery: "Who designed the analytical engine?",
    reasoning: "I should look for the engine designer.",
  });
  assert.equal(seen[0].qid, "q7");
  cleanup();
});

void test("direct search fails the rerank when the worker's docids do not resolve", async () => {
  const { deps, cleanup } = createRuntimeDeps();
  await assert.rejects(
    executeDirectSearchTool(
      { reason: "rerank", query: "analytical engine", hits: 2 },
      undefined,
      { cwd: "." },
      { ...deps, rerankClient: fakeRerankClient(() => ["unknown-doc"], []) as never },
      "call-2",
    ),
    (error: Error) =>
      error.name === "PiSearchRerankError" && /0 resolvable docids for 2/.test(error.message),
  );
  cleanup();
});

void test("direct search without a reranker asks the first stage for k and records no rerank details", async () => {
  const { deps, cleanup } = createRuntimeDeps();
  const result = await executeDirectSearchTool(
    { reason: "plain", query: "analytical engine", hits: 1 },
    undefined,
    { cwd: "." },
    deps,
    "call-3",
  );
  assert.equal(result.details.k, 1);
  assert.equal(result.details.retrievedDocids.length, 1);
  assert.ok(!("rerank" in result.details));
  assert.ok(!("firstStageK" in result.details));
  cleanup();
});
