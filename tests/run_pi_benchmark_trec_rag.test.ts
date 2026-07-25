import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TrecRagOutput } from "../src/evaluation/trec_rag_output";

function runFakePi(finalAssistantText: string): {
  artifact: Record<string, unknown>;
  jsonl: TrecRagOutput;
} {
  const root = mkdtempSync(join(tmpdir(), "run-pi-trec-rag-"));
  const queryPath = join(root, "queries.tsv");
  const outputDir = join(root, "run");
  const fakePiPath = join(root, "fake-pi.sh");
  const assistantEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalAssistantText }],
    },
  });
  writeFileSync(queryPath, "rag2026-0\tExplain alpha.\n", "utf8");
  writeFileSync(
    fakePiPath,
    [
      "#!/bin/sh",
      'test "$PI_SEARCH_PROMPT_VARIANT" = "trec_rag" || exit 9',
      "printf '%s\\n' '{\"type\":\"session\"}'",
      `printf '%s\\n' '${assistantEvent}'`,
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
      "trec-rag-2026",
      "--querySet",
      "test",
      "--query",
      queryPath,
      "--outputDir",
      outputDir,
      "--pi",
      fakePiPath,
      "--timeoutSeconds",
      "5",
      "--promptVariant",
      "trec_rag",
      "--outputMode",
      "answer",
      "--trecRagTeamId",
      "castorini",
      "--trecRagRunId",
      "piika-test",
      "--trecRagRunDesc",
      "Test run.",
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

  return {
    artifact: JSON.parse(readFileSync(join(outputDir, "rag2026-0.json"), "utf8")),
    jsonl: JSON.parse(
      readFileSync(join(outputDir, "rag_output_trec_rag_2026.jsonl"), "utf8"),
    ) as TrecRagOutput,
  };
}

void test("run_pi_benchmark constructs official TREC RAG metadata and JSONL", () => {
  const payload = {
    references: ["shard_00001_2"],
    answer: [{ text: "Alpha is supported.", citations: [0] }],
  };
  const { artifact, jsonl } = runFakePi(JSON.stringify(payload));

  assert.equal(artifact.status, "completed");
  assert.deepEqual(artifact.cited_docids, ["shard_00001_2"]);
  assert.deepEqual(jsonl.answer[0].citations, ["shard_00001_2"]);
  assert.deepEqual(jsonl.metadata, {
    team_id: "castorini",
    narrative_id: "rag2026-0",
    narrative: "Explain alpha.",
    run_id: "piika-test",
    run_desc: "Test run.",
  });
});
