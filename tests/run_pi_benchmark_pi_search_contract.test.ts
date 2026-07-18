import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

void test("run_pi_benchmark collects retrieved docids from pi-search structured details even when rendered tool text is backend-agnostic prose", () => {
  const root = mkdtempSync(join(tmpdir(), "run-pi-benchmark-pi-search-contract-"));
  const queryPath = join(root, "queries.tsv");
  const qrelsPath = join(root, "qrels.txt");
  const outputDir = join(root, "run");
  const fakePiPath = join(root, "fake-pi.sh");

  writeFileSync(queryPath, "1\talpha query\n", "utf8");
  writeFileSync(qrelsPath, "1 0 d1 1\n1 0 d2 1\n", "utf8");
  writeFileSync(
    fakePiPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"session\"}'",
      'printf \'%s\\n\' \'{"type":"tool_execution_start","toolCallId":"1","toolName":"search","args":{"reason":"initial search","query":"alpha query"}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_end","toolCallId":"1","toolName":"search","result":{"content":[{"type":"text","text":"Showing ranks 1-2 of 2 cached hits for search_id=s1\\nPlain query: \\\"alpha query\\\"\\n\\n1. docid=d1\\n2. docid=d2"}],"details":{"retrievedDocids":["d1","d2"]}}}\'',
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Explanation: used structured details. Exact Answer: alpha. Confidence: 50%"}]}}\'',
      "printf '%s\\n' '{\"type\":\"agent_end\"}'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePiPath, 0o755);

  const output = execFileSync(
    "npx",
    [
      "tsx",
      "src/orchestration/run_pi_benchmark.ts",
      "--benchmark",
      "benchmark-template",
      "--querySet",
      "dev",
      "--query",
      queryPath,
      "--qrels",
      qrelsPath,
      "--outputDir",
      outputDir,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--thinking",
      "medium",
      "--extension",
      "src/extensions/pi_search.ts",
      "--pi",
      fakePiPath,
      "--timeoutSeconds",
      "5",
      "--limit",
      "1",
      "--promptVariant",
      "plain_minimal",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_BM25_RPC_HOST: "127.0.0.1",
        PI_BM25_RPC_PORT: "65535",
      },
      encoding: "utf8",
    },
  );

  assert.match(output, /Finished 1\/1 queries/);

  const run = JSON.parse(readFileSync(join(outputDir, "1.json"), "utf8")) as {
    status: string;
    surfaced_docids: string[];
    previewed_docids: string[];
    agent_docids: string[];
    opened_docids: string[];
    cited_docids: string[];
    result: Array<{ type: string; tool_name: string | null; output: string }>;
  };
  assert.equal(run.status, "completed");
  assert.deepEqual(run.surfaced_docids, ["d1", "d2"]);
  assert.deepEqual(run.previewed_docids, ["d1", "d2"]);
  assert.deepEqual(run.agent_docids, []);
  assert.deepEqual(run.opened_docids, []);
  assert.deepEqual(run.cited_docids, []);
  assert.ok(
    run.result.some(
      (entry) =>
        entry.type === "tool_call" &&
        entry.tool_name === "search" &&
        entry.output.includes("Showing ranks 1-2 of 2 cached hits"),
    ),
  );
});

void test("run_pi_benchmark records previewed_docids and agent_docids separately from surfaced_docids", () => {
  const root = mkdtempSync(join(tmpdir(), "run-pi-benchmark-docid-views-"));
  const queryPath = join(root, "queries.tsv");
  const qrelsPath = join(root, "qrels.txt");
  const outputDir = join(root, "run");
  const fakePiPath = join(root, "fake-pi.sh");

  writeFileSync(queryPath, "1\talpha query\n", "utf8");
  writeFileSync(qrelsPath, "1 0 d1 1\n1 0 d2 1\n", "utf8");
  writeFileSync(
    fakePiPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"session\"}'",
      'printf \'%s\\n\' \'{"type":"tool_execution_start","toolCallId":"1","toolName":"search","args":{"reason":"initial search","query":"alpha query"}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_end","toolCallId":"1","toolName":"search","result":{"content":[{"type":"text","text":"Showing ranks 1-2 of 2 cached hits for search_id=s1"}],"details":{"retrievedDocids":["d1","d2"]}}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_start","toolCallId":"2","toolName":"read_document","args":{"reason":"open supporting document","docid":"d2"}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_end","toolCallId":"2","toolName":"read_document","result":{"content":[{"type":"text","text":"[docid=d2 lines 1-1 of 1]\\nrelevant text"}],"details":{"docid":"d2"}}}\'',
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Explanation: grounded on the opened document [2]. Exact Answer: alpha. Confidence: 90%"}]}}\'',
      "printf '%s\\n' '{\"type\":\"agent_end\"}'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePiPath, 0o755);

  execFileSync(
    "npx",
    [
      "tsx",
      "src/orchestration/run_pi_benchmark.ts",
      "--benchmark",
      "benchmark-template",
      "--querySet",
      "dev",
      "--query",
      queryPath,
      "--qrels",
      qrelsPath,
      "--outputDir",
      outputDir,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--thinking",
      "medium",
      "--extension",
      "src/extensions/pi_search.ts",
      "--pi",
      fakePiPath,
      "--timeoutSeconds",
      "5",
      "--limit",
      "1",
      "--promptVariant",
      "plain_minimal",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_BM25_RPC_HOST: "127.0.0.1",
        PI_BM25_RPC_PORT: "65535",
      },
      encoding: "utf8",
    },
  );

  const run = JSON.parse(readFileSync(join(outputDir, "1.json"), "utf8")) as {
    surfaced_docids: string[];
    previewed_docids: string[];
    agent_docids: string[];
    opened_docids: string[];
    cited_docids: string[];
  };
  assert.deepEqual(run.surfaced_docids, ["d1", "d2"]);
  assert.deepEqual(run.previewed_docids, ["d1", "d2"]);
  assert.deepEqual(run.agent_docids, ["d2", "2"]);
  assert.deepEqual(run.opened_docids, ["d2"]);
  assert.deepEqual(run.cited_docids, ["2"]);
});

void test("run_pi_benchmark ranked_list mode parses final ranking and writes TREC run file", () => {
  const root = mkdtempSync(join(tmpdir(), "run-pi-benchmark-ranked-list-"));
  const queryPath = join(root, "queries.tsv");
  const qrelsPath = join(root, "qrels.txt");
  const outputDir = join(root, "run");
  const fakePiPath = join(root, "fake-pi.sh");

  writeFileSync(queryPath, "1\talpha query\n", "utf8");
  writeFileSync(qrelsPath, "1 0 d1 1\n1 0 d2 1\n", "utf8");
  writeFileSync(
    fakePiPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"session\"}'",
      'printf \'%s\\n\' \'{"type":"tool_execution_start","toolCallId":"1","toolName":"search","args":{"reason":"initial search","query":"alpha query"}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_end","toolCallId":"1","toolName":"search","result":{"content":[{"type":"text","text":"Showing ranks 1-2 of 2 cached hits for search_id=s1"}],"details":{"retrievedDocids":["d1","d2"]}}}\'',
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"1. d2\\n2. d1\\n3. d3\\n3. d3"}]}}\'',
      "printf '%s\\n' '{\"type\":\"agent_end\"}'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePiPath, 0o755);

  const output = execFileSync(
    "npx",
    [
      "tsx",
      "src/orchestration/run_pi_benchmark.ts",
      "--benchmark",
      "benchmark-template",
      "--querySet",
      "dev",
      "--query",
      queryPath,
      "--qrels",
      qrelsPath,
      "--outputDir",
      outputDir,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--thinking",
      "medium",
      "--extension",
      "src/extensions/pi_search.ts",
      "--pi",
      fakePiPath,
      "--timeoutSeconds",
      "5",
      "--limit",
      "1",
      "--promptVariant",
      "plain_minimal",
      "--outputMode",
      "ranked_list",
      "--rankedListDepth",
      "10",
      "--rankedListCount",
      "3",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_BM25_RPC_HOST: "127.0.0.1",
        PI_BM25_RPC_PORT: "65535",
      },
      encoding: "utf8",
    },
  );

  assert.match(output, /Wrote ranked-list TREC run file/);

  const run = JSON.parse(readFileSync(join(outputDir, "1.json"), "utf8")) as {
    metadata: { output_mode: string; ranked_list_depth: number; ranked_list_count: number };
    ranked_docids: string[];
    ranked_list_parse_error?: string;
    ranked_list_count_error?: string;
  };
  assert.equal(run.metadata.output_mode, "ranked_list");
  assert.equal(run.metadata.ranked_list_depth, 10);
  assert.equal(run.metadata.ranked_list_count, 3);
  assert.deepEqual(run.ranked_docids, ["d2", "d1", "d3"]);
  assert.equal(run.ranked_list_parse_error, undefined);
  assert.equal(run.ranked_list_count_error, undefined);
  assert.equal(
    readFileSync(join(outputDir, "ranked_list.trec"), "utf8"),
    "1 Q0 d2 1 3 pi-agent\n1 Q0 d1 2 2 pi-agent\n1 Q0 d3 3 1 pi-agent\n",
  );
});

void test("run_pi_benchmark records recoverable search-tool backend failures as benchmark-visible evidence without requiring backend-specific parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "run-pi-benchmark-pi-search-contract-failure-"));
  const queryPath = join(root, "queries.tsv");
  const qrelsPath = join(root, "qrels.txt");
  const outputDir = join(root, "run");
  const fakePiPath = join(root, "fake-pi.sh");

  writeFileSync(queryPath, "1\talpha query\n", "utf8");
  writeFileSync(qrelsPath, "1 0 d1 1\n", "utf8");
  writeFileSync(
    fakePiPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"session\"}'",
      'printf \'%s\\n\' \'{"type":"tool_execution_start","toolCallId":"1","toolName":"search","args":{"reason":"initial search","query":"alpha query"}}\'',
      'printf \'%s\\n\' \'{"type":"tool_execution_end","toolCallId":"1","toolName":"search","isError":true,"result":{"content":[{"type":"text","text":"search failed: backend temporarily unavailable; try again."}],"details":{"retrievedDocids":[]}}}\'',
      'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Explanation: recovered after backend failure. Exact Answer: alpha. Confidence: 60%"}]}}\'',
      "printf '%s\\n' '{\"type\":\"agent_end\"}'",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePiPath, 0o755);

  const output = execFileSync(
    "npx",
    [
      "tsx",
      "src/orchestration/run_pi_benchmark.ts",
      "--benchmark",
      "benchmark-template",
      "--querySet",
      "dev",
      "--query",
      queryPath,
      "--qrels",
      qrelsPath,
      "--outputDir",
      outputDir,
      "--model",
      "openai-codex/gpt-5.4-mini",
      "--thinking",
      "medium",
      "--extension",
      "src/extensions/pi_search.ts",
      "--pi",
      fakePiPath,
      "--timeoutSeconds",
      "5",
      "--limit",
      "1",
      "--promptVariant",
      "plain_minimal",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_BM25_RPC_HOST: "127.0.0.1",
        PI_BM25_RPC_PORT: "65535",
      },
      encoding: "utf8",
    },
  );

  assert.match(output, /Finished 1\/1 queries/);

  const run = JSON.parse(readFileSync(join(outputDir, "1.json"), "utf8")) as {
    status: string;
    stats: { pi_search_failures: number };
    result: Array<{ type: string; tool_name: string | null; output: string }>;
  };
  assert.equal(run.status, "completed");
  assert.equal(run.stats.pi_search_failures, 1);
  assert.ok(
    run.result.some(
      (entry) =>
        entry.type === "output_text" &&
        entry.output.includes(
          "pi-search extension failure (search): search failed: backend temporarily unavailable; try again.",
        ),
    ),
  );
});
