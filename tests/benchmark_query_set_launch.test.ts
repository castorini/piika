import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkQuerySetLaunchEnv,
  buildRunPiBenchmarkCommand,
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
  assert.equal(env.PI_SEARCH_TOOL_INTERFACE, "pyserini-rest-2tool");
});

void test("benchmark query-set launch plan carries ranked-list output mode", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    querySetId: "test",
    outputMode: "ranked_list",
    rankedListDepth: 25,
    rankedListCount: 20,
  });
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {});

  assert.equal(plan.outputMode, "ranked_list");
  assert.equal(plan.rankedListDepth, 25);
  assert.equal(plan.rankedListCount, 20);
  assert.equal(env.OUTPUT_MODE, "ranked_list");
  assert.equal(env.RANKED_LIST_DEPTH, "25");
  assert.equal(env.RANKED_LIST_COUNT, "20");
});

void test("benchmark launch defaults to the direct two-tool interface", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({ benchmarkId: "benchmark-template" });
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {});

  assert.equal(plan.toolInterface, "pyserini-rest-2tool");
  assert.equal(env.PI_SEARCH_TOOL_INTERFACE, "pyserini-rest-2tool");
});

void test("benchmark launch preserves explicit three-tool opt-in", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    toolInterface: "pi-serini-3tool",
  });

  assert.equal(plan.toolInterface, "pi-serini-3tool");
});

void test("ranked-list exact count cannot exceed the configured depth", () => {
  assert.throws(
    () =>
      resolveBenchmarkQuerySetLaunchPlan({
        benchmarkId: "benchmark-template",
        querySetId: "test",
        outputMode: "ranked_list",
        rankedListDepth: 20,
        rankedListCount: 30,
      }),
    /RANKED_LIST_COUNT \(30\) cannot exceed RANKED_LIST_DEPTH \(20\)/,
  );
});

void test("benchmark launch composes answer and ranked-list outputs", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    outputMode: "answer+ranked_list",
    rankedListDepth: 25,
  });
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {});

  assert.equal(plan.outputMode, "answer+ranked_list");
  assert.deepEqual(plan.outputModes, ["answer", "ranked_list"]);
  assert.equal(env.OUTPUT_MODE, "answer+ranked_list");
  assert.equal(env.RANKED_LIST_DEPTH, "25");
});

void test("benchmark query-set launch plan propagates supplied document bundle", () => {
  const plan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: "benchmark-template",
    querySetId: "test",
    suppliedDocBundlePath: "data/supplied-docs/test.jsonl",
  });
  const env = buildBenchmarkQuerySetLaunchEnv(plan, {});
  const command = buildRunPiBenchmarkCommand(plan);

  assert.equal(env.SUPPLIED_DOC_BUNDLE, "data/supplied-docs/test.jsonl");
  assert.deepEqual(command.slice(-2), ["--supplied-doc-bundle", "data/supplied-docs/test.jsonl"]);
});
