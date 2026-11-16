import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { buildPyseriniRestExtensionConfig } from "../../src/pi-search/config";
import { createPiSearchBackend } from "../../src/pi-search/searcher/adapters/create";
import { PiSearchBackendExecutionError } from "../../src/pi-search/searcher/contract/errors";

const SEARCH_OK = JSON.stringify({ query: { text: "ada" }, candidates: [] });

async function withServer(
  handle: (respond: (status: number, body: string) => void) => void,
  run: (baseUrl: string, stats: { requests: number; maxInFlight: number }) => Promise<void>,
) {
  const stats = { requests: 0, maxInFlight: 0 };
  let inFlight = 0;
  const server = createServer((_request, response) => {
    stats.requests += 1;
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    handle((status, body) => {
      inFlight -= 1;
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}`, stats);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const backendFor = (baseUrl: string, extra: Record<string, number> = {}) =>
  createPiSearchBackend(
    process.cwd(),
    buildPyseriniRestExtensionConfig({ baseUrl, index: "test-index", ...extra }),
  );

void test("by default a 429 is not retried (one request, then an execution error)", async () => {
  await withServer(
    (respond) => respond(429, JSON.stringify({ error: "rate limited" })),
    async (baseUrl, stats) => {
      await assert.rejects(
        () => backendFor(baseUrl).search({ query: "ada", limit: 5 }),
        (error: unknown) =>
          error instanceof PiSearchBackendExecutionError && /HTTP 429/.test(error.message),
      );
      assert.equal(stats.requests, 1);
    },
  );
});

void test("maxAttempts retries a 429 and returns the later success", async () => {
  let calls = 0;
  await withServer(
    (respond) => {
      calls += 1;
      if (calls === 1) respond(429, JSON.stringify({ error: "rate limited" }));
      else respond(200, SEARCH_OK);
    },
    async (baseUrl, stats) => {
      const result = await backendFor(baseUrl, { maxAttempts: 3 }).search({
        query: "ada",
        limit: 5,
      });
      assert.deepEqual(result.hits, []);
      assert.equal(stats.requests, 2);
    },
  );
});

void test("maxConcurrentRequests caps requests in flight; unset leaves them concurrent", async () => {
  const slow = (respond: (status: number, body: string) => void) =>
    setTimeout(() => respond(200, SEARCH_OK), 50);
  const burst = (backend: ReturnType<typeof backendFor>) =>
    Promise.all([1, 2, 3].map(() => backend.search({ query: "ada", limit: 5 })));

  await withServer(slow, async (baseUrl, stats) => {
    await burst(backendFor(baseUrl));
    assert.equal(stats.maxInFlight, 3);
  });
  await withServer(slow, async (baseUrl, stats) => {
    await burst(backendFor(baseUrl, { maxConcurrentRequests: 1 }));
    assert.equal(stats.maxInFlight, 1);
  });
});
