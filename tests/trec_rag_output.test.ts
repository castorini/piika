import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTrecRagOutput,
  parseTrecRagAnswerPayload,
  validateTrecRagJsonl,
  validateTrecRagOutput,
  useDirectTrecRagDocidCitations,
  writeTrecRagJsonlFromRunDirectory,
} from "../src/evaluation/trec_rag_output";

const query = { narrativeId: "rag2026-0", narrative: "Explain alpha." };
const metadata = {
  team_id: "castorini",
  narrative_id: query.narrativeId,
  narrative: query.narrative,
  run_id: "piika-test",
  run_desc: "Test run.",
};
const payload = {
  references: ["shard_00001_2", "shard_00002_3"],
  answer: [
    { text: "Alpha is supported.", citations: [0] },
    { text: "Beta is supported too.", citations: [1, 0] },
  ],
};

void test("parseTrecRagAnswerPayload accepts the model-only answer shape", () => {
  assert.deepEqual(parseTrecRagAnswerPayload(JSON.stringify(payload)), payload);
  assert.throws(
    () => parseTrecRagAnswerPayload(JSON.stringify({ metadata, ...payload })),
    /exactly these keys/,
  );
});

void test("validateTrecRagOutput enforces metadata, citations, and word limits", () => {
  const output = buildTrecRagOutput(payload, metadata);
  assert.deepEqual(
    validateTrecRagOutput(output, {
      query,
      teamId: metadata.team_id,
      runId: metadata.run_id,
      runDesc: metadata.run_desc,
    }),
    output,
  );
  assert.throws(
    () =>
      validateTrecRagOutput({
        metadata,
        references: ["shard_00001_2"],
        answer: [{ text: "Unsupported.", citations: [1] }],
      }),
    /out-of-range/,
  );
  assert.throws(
    () =>
      validateTrecRagOutput({
        metadata,
        references: ["shard_00001_2"],
        answer: [
          {
            text: Array.from({ length: 1025 }, () => "word").join(" "),
            citations: [0],
          },
        ],
      }),
    /maximum is 1024/,
  );
  assert.deepEqual(
    validateTrecRagOutput({
      metadata: { ...metadata, generator: "test-model" },
      references: ["shard_00001_2", "shard_00002_3"],
      answer: [{ text: "Direct citation.", citations: ["shard_00001_2"] }],
    }).answer[0].citations,
    ["shard_00001_2"],
  );
  assert.doesNotThrow(() =>
    validateTrecRagOutput({
      metadata,
      references: ["shard_00001_2", "shard_00002_3"],
      answer: [{ text: "One reference is cited.", citations: ["shard_00001_2"] }],
    }),
  );
  assert.throws(
    () =>
      validateTrecRagOutput({
        metadata,
        references: ["shard_00001_2"],
        answer: [{ text: "Missing document.", citations: ["shard_99999_1"] }],
      }),
    /missing from references/,
  );
});

void test("writeTrecRagJsonlFromRunDirectory writes official input order", () => {
  const root = mkdtempSync(join(tmpdir(), "trec-rag-output-"));
  const output = buildTrecRagOutput(payload, metadata);
  writeFileSync(
    join(root, `${query.narrativeId}.json`),
    JSON.stringify({ status: "completed", query_id: query.narrativeId, trec_rag_output: output }),
    "utf8",
  );

  const written = writeTrecRagJsonlFromRunDirectory({
    runDir: root,
    queries: [query],
    teamId: metadata.team_id,
    runId: metadata.run_id,
    runDesc: metadata.run_desc,
  });
  assert.equal(written.recordCount, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(written.outputPath, "utf8")),
    useDirectTrecRagDocidCitations(output),
  );
  assert.equal(
    validateTrecRagJsonl({
      inputPath: written.outputPath,
      queries: [query],
      expectedCount: 1,
    }).length,
    1,
  );
});

void test("writeTrecRagJsonlFromRunDirectory rejects failed artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "trec-rag-output-failed-"));
  writeFileSync(
    join(root, `${query.narrativeId}.json`),
    JSON.stringify({ status: "failed", query_id: query.narrativeId }),
    "utf8",
  );
  assert.throws(
    () =>
      writeTrecRagJsonlFromRunDirectory({
        runDir: root,
        queries: [query],
        teamId: metadata.team_id,
        runId: metadata.run_id,
        runDesc: metadata.run_desc,
      }),
    /has status failed/,
  );
});
