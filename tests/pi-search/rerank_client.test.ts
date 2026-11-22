import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  PiSearchRerankError,
  RerankWorkerClient,
  selectContextFields,
} from "../../src/pi-search/rerank/client";

async function withWorker(
  handler: (body: any) => { status?: number; payload?: unknown },
  run: (url: string, seen: () => any) => Promise<void>,
) {
  let last: any = null;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      last = JSON.parse(raw || "{}");
      const { status = 200, payload = {} } = handler(last);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}`, () => last);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const CANDIDATES = [
  { docid: "a", text: "alpha" },
  { docid: "b", text: "bravo" },
  { docid: "c", text: "charlie" },
];

void test("sends context fields and applies the returned order", async () => {
  await withWorker(
    () => ({
      payload: {
        docids: ["c", "a"],
        usage: { prompt_tokens: 900, calls: 1 },
        context_fields: ["global_query"],
      },
    }),
    async (url, seen) => {
      const client = new RerankWorkerClient({ workerUrl: url, contextMode: "full", depth: 100 });
      const out = await client.rerank("q1", "the query", CANDIDATES, 2, {
        globalQuery: "G",
        reasoning: "R",
      });
      assert.deepEqual(out.docids, ["c", "a"]);
      assert.equal(out.failed, false);
      assert.equal(out.usage.promptTokens, 900);
      assert.deepEqual(seen().extra_fields, { global_query: "G", reasoning: "R" });
      assert.equal(seen().top_k, 2);
    },
  );
});

void test("a worker failure is retried with backoff and then thrown, never a silent fallback", async () => {
  let requests = 0;
  await withWorker(
    () => {
      requests += 1;
      return { status: 500, payload: { error: "boom" } };
    },
    async (url) => {
      const client = new RerankWorkerClient({
        workerUrl: url,
        depth: 100,
        retryAttempts: 3,
        retryBaseDelayMs: 5,
      });
      await assert.rejects(
        client.rerank("q1", "the query", CANDIDATES, 2, {}),
        (error: unknown) =>
          error instanceof PiSearchRerankError && /after 3 attempts.*HTTP 500/.test(error.message),
      );
      assert.equal(requests, 3, "every attempt reached the worker");
    },
  );
});

void test("an unreachable worker aborts the query instead of continuing on first-stage order", async () => {
  const client = new RerankWorkerClient({
    workerUrl: "http://127.0.0.1:9",
    depth: 100,
    timeoutMs: 500,
    retryAttempts: 2,
    retryBaseDelayMs: 5,
  });
  await assert.rejects(
    client.rerank("q1", "q", CANDIDATES, 3, {}),
    (error: unknown) => error instanceof PiSearchRerankError,
  );
});

void test("never sends more context than the mode allows", () => {
  const both = { globalQuery: "G", reasoning: "R" };
  assert.deepEqual(selectContextFields("none", both), {});
  assert.deepEqual(selectContextFields("global_query", both), { global_query: "G" });
  assert.deepEqual(selectContextFields("reasoning", both), { reasoning: "R" });
  assert.deepEqual(selectContextFields("full", both), { global_query: "G", reasoning: "R" });
});

void test("degrades per call when the agent produced no trace", () => {
  assert.deepEqual(
    selectContextFields("full", { globalQuery: "G" }),
    { global_query: "G" },
    "an absent field is omitted, not sent empty",
  );
  assert.deepEqual(selectContextFields("full", { globalQuery: "G", reasoning: "   " }), {
    global_query: "G",
  });
  assert.deepEqual(selectContextFields("full", {}), {});
});

void test("depth caps what is sent to the worker", async () => {
  await withWorker(
    () => ({ payload: { docids: ["a"], usage: {} } }),
    async (url, seen) => {
      const client = new RerankWorkerClient({ workerUrl: url, depth: 2 });
      await client.rerank("q1", "q", CANDIDATES, 1, {});
      assert.equal(seen().candidates.length, 2);
      assert.equal(seen().depth, 2);
    },
  );
});
