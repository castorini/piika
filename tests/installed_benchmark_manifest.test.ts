import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installBenchmarkManifest, loadInstalledBenchmarks } from "../src/benchmarks/installed";

function writeManifest(path: string, id = "custom-example"): void {
  writeFileSync(
    path,
    JSON.stringify({
      id,
      aliases: ["example"],
      displayName: "Custom Example",
      datasetId: "custom-example",
      piSearchPromptVariant: "plain_minimal",
      defaultQuerySetId: "test",
      defaultQueryPath: "data/custom/queries.tsv",
      querySets: { test: "data/custom/queries.tsv" },
      defaultQrelsPath: "data/custom/qrels.txt",
      defaultGroundTruthPath: "data/custom/ground-truth.jsonl",
      defaultIndexPath: "example-index",
      managedPresets: {},
      setup: { steps: {} },
      retrievalEvaluation: { runFileBackend: "internal", runDirBackend: "internal" },
      judgeEvaluation: {
        supportedModes: ["gold-answer", "reference-free"],
        defaultMode: "gold-answer",
      },
    }),
    "utf8",
  );
}

void test("generic manifest installer validates and installs custom benchmarks", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-install-manifest-"));
  const sourcePath = join(root, "source.json");
  const installRoot = join(root, "installed");
  writeManifest(sourcePath);

  const result = installBenchmarkManifest({ sourcePath, root: installRoot });
  assert.equal(result.benchmark.id, "custom-example");
  assert.equal(result.written, true);
  assert.equal(result.targetPath, join(installRoot, "custom-example", "benchmark.json"));
  assert.equal(JSON.parse(readFileSync(result.targetPath, "utf8")).id, "custom-example");
  assert.equal(loadInstalledBenchmarks(installRoot)[0].defaultIndexPath, "example-index");
});

void test("generic manifest installer dry-run validates without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-install-manifest-dry-"));
  const sourcePath = join(root, "source.json");
  writeManifest(sourcePath);

  const result = installBenchmarkManifest({
    sourcePath,
    root: join(root, "installed"),
    dryRun: true,
  });
  assert.equal(result.written, false);
  assert.equal(loadInstalledBenchmarks(join(root, "installed")).length, 0);
});

void test("generic manifest installer is idempotent and protects differing manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-install-manifest-existing-"));
  const sourcePath = join(root, "source.json");
  const installRoot = join(root, "installed");
  writeManifest(sourcePath);
  installBenchmarkManifest({ sourcePath, root: installRoot });
  assert.equal(installBenchmarkManifest({ sourcePath, root: installRoot }).written, false);

  const changed = JSON.parse(readFileSync(sourcePath, "utf8")) as { displayName: string };
  changed.displayName = "Changed Example";
  writeFileSync(sourcePath, JSON.stringify(changed), "utf8");
  assert.throws(
    () => installBenchmarkManifest({ sourcePath, root: installRoot }),
    /already exists with different contents/,
  );
  assert.equal(
    installBenchmarkManifest({ sourcePath, root: installRoot, force: true }).written,
    true,
  );
});

void test("installed benchmark ids cannot escape the manifest root", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-install-manifest-unsafe-"));
  const sourcePath = join(root, "source.json");
  writeManifest(sourcePath, "../outside");
  assert.throws(
    () => installBenchmarkManifest({ sourcePath, root: join(root, "installed") }),
    /missing required fields/,
  );
});
