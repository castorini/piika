import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { importSearchJsonlRun, inferQuerySetId } from "../src/adapters/import_search_jsonl_run";

void test("inferQuerySetId resolves the smallest matching benchmark query set", () => {
  assert.equal(inferQuerySetId("benchmark-template", ["q1"]), "dev");
  assert.equal(inferQuerySetId("benchmark-template", ["q1", "q2"]), "dev");
});

void test("importSearchJsonlRun writes normalized run artifacts for evaluation", async () => {
  const root = mkdtempSync(join(tmpdir(), "import-search-jsonl-run-"));
  const inputJsonl = join(root, "external-model.jsonl");
  const outputDir = join(root, "run");

  writeFileSync(
    inputJsonl,
    [
      JSON.stringify({
        query_id: "q1",
        status: "completed",
        search_counts: 2,
        result: [
          { type: "reasoning", output: [] },
          {
            type: "tool_call",
            tool_name: "search",
            output: JSON.stringify([{ docid: "d2" }, { docid: "d1" }]),
          },
          {
            type: "tool_call",
            tool_name: "search",
            output: JSON.stringify([{ docid: "d1" }, { docid: "d3" }]),
          },
          { type: "output_text", output: "Final answer with citation [3]." },
        ],
      }),
      JSON.stringify({
        query_id: "q2",
        status: "incomplete",
        search_counts: 1,
        result: [
          {
            type: "tool_call",
            tool_name: "search",
            output: JSON.stringify([{ docid: "d9" }, { docid: 10 }]),
          },
        ],
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const summary = await importSearchJsonlRun({
    inputJsonl,
    outputDir,
    benchmarkId: "benchmark-template",
    model: "demo-model",
  });

  assert.equal(summary.benchmarkId, "benchmark-template");
  assert.equal(summary.querySetId, "dev");
  assert.equal(summary.queryCount, 2);

  const q1 = JSON.parse(readFileSync(join(outputDir, "q1.json"), "utf8")) as {
    surfaced_docids: string[];
    previewed_docids: string[];
    tool_call_counts: Record<string, number>;
    metadata: Record<string, string>;
    status: string;
  };
  assert.deepEqual(q1.surfaced_docids, ["d2", "d1", "d3"]);
  assert.deepEqual(q1.previewed_docids, ["d2", "d1", "d3"]);
  assert.deepEqual(q1.tool_call_counts, { search: 2 });
  assert.equal(q1.metadata.model, "demo-model");
  assert.equal(q1.metadata.query, "What color is the demo sky?");
  assert.equal(q1.status, "completed");

  const q2 = JSON.parse(readFileSync(join(outputDir, "q2.json"), "utf8")) as {
    surfaced_docids: string[];
    status: string;
  };
  assert.deepEqual(q2.surfaced_docids, ["d9", "10"]);
  assert.equal(q2.status, "incomplete");

  const manifest = JSON.parse(
    readFileSync(join(outputDir, "benchmark_manifest_snapshot.json"), "utf8"),
  ) as {
    benchmark_id: string;
    query_set_id: string;
    query_path: string;
  };
  assert.equal(manifest.benchmark_id, "benchmark-template");
  assert.equal(manifest.query_set_id, "dev");
  assert.equal(manifest.query_path, "data/benchmark-template/queries/dev.tsv");

  const runSetup = JSON.parse(readFileSync(join(outputDir, "run_setup.json"), "utf8")) as {
    model: string;
    importSourcePath: string;
    importAdapter: string;
    totalQueries: string;
  };
  assert.equal(runSetup.model, "demo-model");
  assert.equal(runSetup.importSourcePath, inputJsonl);
  assert.equal(runSetup.importAdapter, "search-jsonl-run/v1");
  assert.equal(runSetup.totalQueries, "2");
});
