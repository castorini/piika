import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Opt-in run records: PIIKA_RECORD_AGENT_USAGE=1 sums the token usage pi
 * reports per assistant message into stats.usage, and PI_SEARCH_FAIL_FAST=1
 * classifies failed runs (failure.kind) and counts pi's LLM retries. Unset,
 * the run record is unchanged.
 */

type RunRecord = {
  status: string;
  failure?: { kind: string; tool?: string; message: string };
  stats: {
    assistant_turns: number;
    agent_retries?: number;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      reasoning: number;
      assistantTurnsWithUsage: number;
      cost: { input: number; output: number; total: number };
    };
  };
};

function runFakePi(
  assistantMessages: string[],
  env: Record<string, string> = { PIIKA_RECORD_AGENT_USAGE: "1" },
  tail: string[] = [],
): RunRecord {
  const root = mkdtempSync(join(tmpdir(), "run-pi-benchmark-usage-"));
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
      ...assistantMessages.map((line) => `printf '%s\\n' '${line}'`),
      "printf '%s\\n' '{\"type\":\"agent_end\"}'",
      ...tail,
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
        PIIKA_RECORD_AGENT_USAGE: "",
        PI_SEARCH_FAIL_FAST: "",
        ...env,
        PI_BM25_RPC_HOST: "127.0.0.1",
        PI_BM25_RPC_PORT: "65535",
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(readFileSync(join(outputDir, "1.json"), "utf8")) as RunRecord;
}

const withUsage = (text: string, usage: string) =>
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"usage":${usage}}}`;

void test("run_pi_benchmark sums token usage and cost across assistant turns", () => {
  const record = runFakePi([
    withUsage(
      "thinking out loud",
      '{"input":100,"output":20,"cacheRead":5,"cacheWrite":2,"totalTokens":127,"reasoning":7,"cost":{"input":0.1,"output":0.2,"cacheRead":0.01,"cacheWrite":0.02,"total":0.33}}',
    ),
    withUsage(
      "Explanation: done. Exact Answer: alpha. Confidence: 50%",
      '{"input":200,"output":30,"cacheRead":1,"cacheWrite":0,"totalTokens":231,"reasoning":3,"cost":{"input":0.2,"output":0.3,"cacheRead":0,"cacheWrite":0,"total":0.5}}',
    ),
  ]);

  const usage = record.stats.usage;
  assert.equal(usage.input, 300);
  assert.equal(usage.output, 50);
  assert.equal(usage.cacheRead, 6);
  assert.equal(usage.cacheWrite, 2);
  assert.equal(usage.totalTokens, 358);
  assert.equal(usage.reasoning, 10);
  assert.equal(usage.assistantTurnsWithUsage, 2);
  assert.ok(Math.abs(usage.cost.total - 0.83) < 1e-9);
});

void test("run_pi_benchmark reports zeroed usage when pi sends none", () => {
  const record = runFakePi([
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Explanation: no usage. Exact Answer: alpha. Confidence: 10%"}]}}',
  ]);

  const usage = record.stats.usage;
  assert.equal(usage.assistantTurnsWithUsage, 0, "a turn with no usage must not be counted");
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.cost.total, 0);
  assert.equal(record.stats.assistant_turns, 1, "the turn itself still counts");
});

const ANSWER = "Explanation: done. Exact Answer: alpha. Confidence: 50%";

void test("without PIIKA_RECORD_AGENT_USAGE the run record has no usage field", () => {
  const record = runFakePi([withUsage(ANSWER, '{"input":100,"output":20,"totalTokens":120}')], {});
  assert.equal(record.status, "completed");
  assert.ok(!("usage" in record.stats));
  assert.ok(!("agent_retries" in record.stats));
  assert.ok(!("failure" in record));
});

const ERRORED_TURN =
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"error","errorMessage":"upstream 503"}}';

void test("PI_SEARCH_FAIL_FAST classifies an agent LLM failure and counts pi's retries", () => {
  const messages = [
    '{"type":"auto_retry_start"}',
    ERRORED_TURN,
    '{"type":"auto_retry_end","success":false,"finalError":"upstream 503 after retries"}',
  ];
  const off = runFakePi(messages, {});
  assert.ok(!("failure" in off));
  assert.ok(!("agent_retries" in off.stats));

  const on = runFakePi(messages, { PI_SEARCH_FAIL_FAST: "1" });
  assert.equal(on.status, "failed");
  assert.deepEqual(on.failure, {
    kind: "agent_inference_error",
    message: "upstream 503 after retries",
  });
  assert.equal(on.stats.agent_retries, 1);
});

void test("PI_SEARCH_FAIL_FAST: a recovered retry is not a failure", () => {
  const record = runFakePi(
    [
      '{"type":"auto_retry_start"}',
      ERRORED_TURN,
      '{"type":"auto_retry_end","success":true}',
      withUsage(ANSWER, "{}"),
    ],
    { PI_SEARCH_FAIL_FAST: "1" },
  );
  assert.equal(record.status, "completed");
  assert.ok(!("failure" in record));
  assert.equal(record.stats.agent_retries, 1);
});

void test("PI_SEARCH_FAIL_FAST records the extension's fatal marker as the failure", () => {
  const fatal = [
    `printf '%s\\n' '[pi-search] FATAL kind=retrieval_error tool=search message=HTTP 503: overloaded' >&2`,
    "exit 75",
  ];
  const off = runFakePi([withUsage(ANSWER, "{}")], {}, fatal);
  assert.equal(off.status, "failed");
  assert.ok(!("failure" in off));

  const on = runFakePi([withUsage(ANSWER, "{}")], { PI_SEARCH_FAIL_FAST: "1" }, fatal);
  assert.equal(on.status, "failed");
  assert.deepEqual(on.failure, {
    kind: "retrieval_error",
    tool: "search",
    message: "HTTP 503: overloaded",
  });
});
