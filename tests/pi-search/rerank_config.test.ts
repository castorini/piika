import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPiSearchRerankConfigFromFlags,
  formatRerankCliArgs,
  pickRerankCliFlags,
  resolvePiSearchRerankConfig,
} from "../../src/pi-search/rerank/config";

void test("no rerank flags and no env means no reranking", () => {
  assert.equal(resolvePiSearchRerankConfig({}, {}), null);
  assert.equal(
    resolvePiSearchRerankConfig(pickRerankCliFlags({ model: "m", limit: "0" }), {}),
    null,
  );
});

void test("rerank flags build a validated config with numeric fields", () => {
  const config = buildPiSearchRerankConfigFromFlags({
    rerankWorkerUrl: "http://127.0.0.1:8200",
    rerankContextMode: "full",
    rerankDepth: "100",
    rerankMaxTraceChars: "8192",
  });
  assert.deepEqual(config, {
    workerUrl: "http://127.0.0.1:8200",
    contextMode: "full",
    depth: 100,
    maxTraceChars: 8192,
  });
});

void test("rerank flags are refused without a worker url, with a bad number, or a bad mode", () => {
  assert.throws(
    () => buildPiSearchRerankConfigFromFlags({ rerankDepth: "50" }),
    /--rerank-worker-url/,
  );
  assert.throws(
    () => buildPiSearchRerankConfigFromFlags({ rerankWorkerUrl: "http://w", rerankDepth: "many" }),
    /--rerank-depth must be a number/,
  );
  assert.throws(
    () =>
      buildPiSearchRerankConfigFromFlags({ rerankWorkerUrl: "http://w", rerankContextMode: "all" }),
    /Invalid --rerank-\* flags/,
  );
});

void test("flags and PI_SEARCH_RERANK_CONFIG are alternatives, not merged", () => {
  const env = { PI_SEARCH_RERANK_CONFIG: '{"workerUrl":"http://env","depth":20}' };
  assert.deepEqual(resolvePiSearchRerankConfig({}, env), { workerUrl: "http://env", depth: 20 });
  assert.throws(
    () => resolvePiSearchRerankConfig({ rerankWorkerUrl: "http://flag" }, env),
    /not both/,
  );
});

void test("parsed runner arguments round-trip through the launcher's forwarded flags", () => {
  const flags = pickRerankCliFlags({
    rerankWorkerUrl: "http://w",
    rerankContextMode: "reasoning",
    outputDir: "runs/x",
  });
  assert.deepEqual(formatRerankCliArgs(flags), [
    "--rerankWorkerUrl",
    "http://w",
    "--rerankContextMode",
    "reasoning",
  ]);
});
