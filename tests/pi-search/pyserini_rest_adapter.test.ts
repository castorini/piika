import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildPyseriniRestExtensionConfig } from "../../src/pi-search/config";
import { createPiSearchBackend } from "../../src/pi-search/searcher/adapters/create";
import { PiSearchBackendExecutionError } from "../../src/pi-search/searcher/contract/errors";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind HTTP test server."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

void test("pyserini-rest adapter maps native search and doc responses into the shared backend contract", async () => {
  const server = createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && url.pathname === "/v1/browsecomp-plus/search") {
      assert.equal(url.searchParams.get("query"), "ada analytical engine");
      assert.equal(url.searchParams.get("hits"), "5");
      assert.equal(url.searchParams.get("max_doc_length"), "64");
      response.end(
        JSON.stringify({
          api: "v1",
          index: "browsecomp-plus",
          query: { text: "ada analytical engine" },
          candidates: [
            {
              docid: "doc-1",
              score: 4.25,
              rank: 1,
              doc: {
                title: "Ada Lovelace",
                contents: "Ada Lovelace wrote notes on the analytical engine.",
              },
            },
          ],
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/browsecomp-plus/doc/doc-1") {
      assert.equal(url.searchParams.has("max_doc_length"), false);
      response.end(
        JSON.stringify({
          api: "v1",
          index: "browsecomp-plus",
          docid: "doc-1",
          doc: "Ada Lovelace wrote notes on the analytical engine.",
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  const port = await listen(server);
  try {
    const backend = createPiSearchBackend(
      process.cwd(),
      buildPyseriniRestExtensionConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        index: "browsecomp-plus",
        searchMaxDocLength: 64,
      }),
    );

    const searchResult = await backend.search({ query: "ada analytical engine", limit: 5 });
    assert.equal(searchResult.hits.length, 1);
    assert.equal(searchResult.hits[0].docid, "doc-1");
    assert.equal(searchResult.hits[0].score, 4.25);
    assert.equal(searchResult.hits[0].title, "Ada Lovelace");
    assert.match(searchResult.hits[0].snippet ?? "", /Ada Lovelace/);

    const readResult = await backend.readDocument({ docid: "doc-1" });
    assert.equal(readResult.found, true);
    if (readResult.found) {
      assert.equal(readResult.offset, 1);
      assert.equal(readResult.limit, 1);
      assert.equal(readResult.returnedOffsetStart, 1);
      assert.equal(readResult.returnedOffsetEnd, 1);
      assert.equal(readResult.text, "Ada Lovelace wrote notes on the analytical engine.");
      assert.equal(readResult.truncated, false);
      assert.equal(readResult.nextOffset, undefined);
    }
  } finally {
    await close(server);
  }
});

void test("pyserini-rest adapter rejects paginated read-document requests instead of inventing local slicing semantics", async () => {
  const backend = createPiSearchBackend(
    process.cwd(),
    buildPyseriniRestExtensionConfig({
      baseUrl: "http://127.0.0.1:1",
      index: "browsecomp-plus",
    }),
  );

  await assert.rejects(
    () => backend.readDocument({ docid: "doc-1", offset: 2, limit: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof PiSearchBackendExecutionError);
      assert.match(error.message, /paginated offset\/limit reads require readMode='paginated'/);
      return true;
    },
  );
});

void test("pyserini-rest adapter supports donor-compatible paginated read mode when enabled", async () => {
  const server = createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && url.pathname === "/v1/browsecomp-plus/doc/doc-1") {
      assert.equal(url.searchParams.has("max_doc_length"), false);
      response.end(
        JSON.stringify({
          docid: "doc-1",
          doc: "line 1\nline 2\nline 3\nline 4",
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  const port = await listen(server);
  try {
    const backend = createPiSearchBackend(
      process.cwd(),
      buildPyseriniRestExtensionConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        index: "browsecomp-plus",
        readMode: "paginated",
      }),
    );

    const readResult = await backend.readDocument({ docid: "doc-1", offset: 2, limit: 2 });
    assert.equal(readResult.found, true);
    if (readResult.found) {
      assert.equal(readResult.offset, 2);
      assert.equal(readResult.limit, 2);
      assert.equal(readResult.totalUnits, 4);
      assert.equal(readResult.returnedOffsetStart, 2);
      assert.equal(readResult.returnedOffsetEnd, 3);
      assert.equal(readResult.text, "line 2\nline 3");
      assert.equal(readResult.truncated, true);
      assert.equal(readResult.nextOffset, 4);
    }
  } finally {
    await close(server);
  }
});

void test("pyserini-rest adapter handles absolute index paths and bearer tokens", async () => {
  const tokenEnv = "PI_SEARCH_PYSERINI_REST_ADAPTER_TEST_TOKEN";
  process.env[tokenEnv] = "secret-token";

  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer secret-token");
    assert.equal(request.method, "GET");
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    assert.equal(url.pathname, "/v1//data/indexes/demo/search");
    assert.equal(url.searchParams.get("max_doc_length"), "500");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ candidates: [] }));
  });

  const port = await listen(server);
  try {
    const backend = createPiSearchBackend(
      process.cwd(),
      buildPyseriniRestExtensionConfig({
        baseUrl: `http://127.0.0.1:${port}/`,
        index: "/data/indexes/demo",
        tokenEnv,
      }),
    );

    const searchResult = await backend.search({ query: "empty", limit: 10 });
    assert.deepEqual(searchResult.hits, []);
  } finally {
    delete process.env[tokenEnv];
    await close(server);
  }
});

void test("pyserini-rest adapter maps missing documents to not-found responses", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "document not found" }));
  });

  const port = await listen(server);
  try {
    const backend = createPiSearchBackend(
      process.cwd(),
      buildPyseriniRestExtensionConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        index: "browsecomp-plus",
      }),
    );

    const readResult = await backend.readDocument({ docid: "missing-doc" });
    assert.deepEqual(readResult.found, false);
    assert.equal(readResult.docid, "missing-doc");
  } finally {
    await close(server);
  }
});

void test("pyserini-rest adapter surfaces non-2xx search responses as execution errors", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Unable to open index" }));
  });

  const port = await listen(server);
  try {
    const backend = createPiSearchBackend(
      process.cwd(),
      buildPyseriniRestExtensionConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        index: "bad-index",
      }),
    );

    await assert.rejects(
      () => backend.search({ query: "ada", limit: 10 }),
      (error: unknown) => {
        assert.ok(error instanceof PiSearchBackendExecutionError);
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /Unable to open index/);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});
