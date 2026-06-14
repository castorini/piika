import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkQuerySetLaunchEnv,
  resolveBenchmarkQuerySetLaunchPlan,
} from "../src/orchestration/benchmark_query_set_launch";

void test("benchmark query-set launch env builds hosted Pyserini REST config from shorthand env", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    querySetId: "test",
  });
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {
    PYSERINI_REST_BASE_URL: "https://pyserini-rest.example.test",
    PYSERINI_REST_INDEX: "custom-index",
    PYSERINI_API_TOKEN: "secret-token",
  });

  assert.equal(env.PI_SEARCH_TOOL_INTERFACE, "pyserini-rest-2tool");
  assert.equal(env.BENCHMARK, "benchmark-template");
  assert.equal(env.QUERY_FILE, "data/benchmark-template/queries/test.tsv");
  assert.equal(env.QRELS_FILE, "data/benchmark-template/qrels/qrel_primary.txt");
  assert.equal(env.PI_BM25_INDEX_PATH, "indexes/benchmark-template-bm25");

  const config = JSON.parse(env.PI_SEARCH_EXTENSION_CONFIG ?? "");
  assert.deepEqual(config, {
    backend: {
      kind: "pyserini-rest",
      baseUrl: "https://pyserini-rest.example.test",
      index: "custom-index",
      tokenEnv: "PYSERINI_API_TOKEN",
      readMode: "paginated",
    },
  });
});

void test("explicit PI_SEARCH_EXTENSION_CONFIG wins over Pyserini REST shorthand env", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    querySetId: "test",
  });
  const explicitConfig = '{"backend":{"kind":"mock","documents":[]}}';
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {
    PI_SEARCH_EXTENSION_CONFIG: explicitConfig,
    PYSERINI_REST_BASE_URL: "https://pyserini-rest.example.test",
    PYSERINI_REST_INDEX: "custom-index",
  });

  assert.equal(env.PI_SEARCH_EXTENSION_CONFIG, explicitConfig);
  assert.equal(env.PI_SEARCH_TOOL_INTERFACE, undefined);
});
