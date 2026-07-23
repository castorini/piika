import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareMultiAnswerGroundTruth } from "../src/adapters/prepare_multi_answer_ground_truth";

void test("multi-answer adapter joins queries and configurable answer fields", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-multi-answer-"));
  const queriesPath = join(root, "queries.tsv");
  const answersPath = join(root, "answers.jsonl");
  const outputPath = join(root, "ground-truth", "answers.jsonl");
  writeFileSync(queriesPath, "q1\tFirst question?\nq2\tSecond\tquestion?\n", "utf8");
  writeFileSync(
    answersPath,
    [
      JSON.stringify({ query_id: "q1", acceptable: ["Alpha", " Alpha ", "", 42] }),
      JSON.stringify({ query_id: "q2", acceptable: ["Beta"] }),
    ].join("\n"),
    "utf8",
  );

  const result = prepareMultiAnswerGroundTruth({
    queriesPath,
    answersPath,
    outputPath,
    idField: "query_id",
    answersField: "acceptable",
  });

  assert.equal(result.rowCount, 2);
  assert.deepEqual(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      { query_id: "q1", query: "First question?", answer: '["Alpha"]' },
      { query_id: "q2", query: "Second\tquestion?", answer: '["Beta"]' },
    ],
  );
});

void test("multi-answer adapter rejects missing and duplicate answer rows", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-multi-answer-invalid-"));
  const queriesPath = join(root, "queries.tsv");
  const answersPath = join(root, "answers.jsonl");
  writeFileSync(queriesPath, "q1\tQuestion?\n", "utf8");
  writeFileSync(
    answersPath,
    `${JSON.stringify({ qid: "q1", answer: ["Alpha"] })}\n${JSON.stringify({
      qid: "q1",
      answer: ["Beta"],
    })}\n`,
    "utf8",
  );

  assert.throws(
    () =>
      prepareMultiAnswerGroundTruth({
        queriesPath,
        answersPath,
        outputPath: join(root, "out.jsonl"),
      }),
    /Duplicate answer row for query q1/,
  );
});
