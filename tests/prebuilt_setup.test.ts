import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadInstalledBenchmarks } from "../src/benchmarks/installed";
import { getBenchmarkDefinition, resolveBenchmarkConfig } from "../src/benchmarks/registry";
import type { PrebuiltCatalog } from "../src/prebuilt/catalog";
import {
  normalizeAnseriniTopics,
  resolvePrebuiltSetupPlan,
  setupPrebuiltBenchmark,
} from "../src/prebuilt/setup";

const catalog: PrebuiltCatalog = {
  indexes: [
    {
      name: "example-index",
      type: "inverted",
      corpus: "Example Corpus",
      corpus_index: "example-corpus",
      description: "Example index",
      filename: "example.tar.gz",
      readme: "",
      urls: ["https://example.test/example.tar.gz"],
      md5: "0123456789abcdef0123456789abcdef",
      size: 42,
    },
  ],
  topics: [
    {
      id: "example-test",
      path: "topics.example.tsv.gz",
      readerClass: "io.anserini.search.topicreader.TsvStringTopicReader",
    },
  ],
  qrels: [
    {
      id: "example",
      path: "qrels.example.txt",
      aliases: ["example-test"],
    },
  ],
};

void test("Anserini topic normalization supports compressed TSV, JSONL, and TREC topics", () => {
  assert.equal(
    normalizeAnseriniTopics(catalog.topics[0], gzipSync("q1\tfirst query\nq2\tsecond query\n")),
    "q1\tfirst query\nq2\tsecond query\n",
  );
  assert.equal(
    normalizeAnseriniTopics(
      {
        id: "json",
        path: "topics.jsonl",
        readerClass: "io.anserini.search.topicreader.JsonStringTopicReader",
      },
      Buffer.from('{"id":"q1","title":"json query"}\n'),
    ),
    "q1\tjson query\n",
  );
  assert.equal(
    normalizeAnseriniTopics(
      {
        id: "trec",
        path: "topics.txt",
        readerClass: "io.anserini.search.topicreader.TrecTopicReader",
      },
      Buffer.from("<top>\n<num> Number: 301\n<title> International Organized Crime\n</top>\n"),
    ),
    "301\tInternational Organized Crime\n",
  );
});

void test("prebuilt setup plan resolves a qrels alias without hard-coded benchmark data", async () => {
  const root = mkdtempSync(join(tmpdir(), "piika-prebuilt-plan-"));
  const { plan } = await resolvePrebuiltSetupPlan({
    rootDir: root,
    indexId: "example-index",
    topicsId: "example-test",
    catalog,
  });
  assert.equal(plan.benchmarkId, "prebuilt-example-index-example-test");
  assert.equal(plan.qrelsId, "example");
  assert.equal(plan.indexPath, join(root, "indexes", "example-index"));
  assert.equal(
    plan.manifestPath,
    join(root, "data", "prebuilt", "prebuilt-example-index-example-test", "benchmark.json"),
  );
});

void test("prebuilt setup rejects catalog paths that escape managed directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "piika-prebuilt-paths-"));
  const unsafeIndexCatalog = structuredClone(catalog);
  unsafeIndexCatalog.indexes[0].name = "../outside";
  await assert.rejects(
    resolvePrebuiltSetupPlan({
      rootDir: root,
      indexId: "../outside",
      topicsId: "example-test",
      catalog: unsafeIndexCatalog,
    }),
    /Prebuilt index id escapes its destination directory/,
  );

  const unsafeTopicCatalog = structuredClone(catalog);
  unsafeTopicCatalog.topics[0].path = "../topics.tsv";
  await assert.rejects(
    resolvePrebuiltSetupPlan({
      rootDir: root,
      indexId: "example-index",
      topicsId: "example-test",
      catalog: unsafeTopicCatalog,
    }),
    /Topics path escapes its destination directory/,
  );
});

void test("prebuilt setup writes a dynamically loadable benchmark manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "piika-prebuilt-setup-"));
  mkdirSync(join(root, "indexes", "example-index"), { recursive: true });
  mkdirSync(join(root, "vendor", "anserini"), { recursive: true });
  writeFileSync(join(root, "vendor", "anserini", "anserini-1.6.0-fatjar.jar"), "jar");
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("topics.example.tsv.gz")) {
      return new Response(gzipSync("q1\texample query\n"));
    }
    if (url.endsWith("qrels.example.txt")) {
      return new Response("q1 0 d1 1\n");
    }
    return new Response("missing", { status: 404 });
  };

  const plan = await setupPrebuiltBenchmark({
    rootDir: root,
    indexId: "example-index",
    topicsId: "example-test",
    catalog,
    fetchImpl,
  });
  assert.equal(readFileSync(plan.queryPath, "utf8"), "q1\texample query\n");
  assert.equal(readFileSync(plan.qrelsPath, "utf8"), "q1 0 d1 1\n");
  const installed = loadInstalledBenchmarks(join(root, "data", "prebuilt"));
  assert.equal(installed.length, 1);
  assert.equal(installed[0].id, plan.benchmarkId);
  assert.equal(installed[0].defaultQuerySetId, "example-test");
  assert.match(installed[0].defaultIndexPath, /indexes\/example-index$/);
  assert.deepEqual(installed[0].source, {
    kind: "castorini-prebuilt",
    indexId: "example-index",
    indexUrl: "https://example.test/example.tar.gz",
    indexMd5: "0123456789abcdef0123456789abcdef",
    topicsId: "example-test",
    topicsUrl:
      "https://raw.githubusercontent.com/castorini/anserini-tools/master/topics-and-qrels/topics.example.tsv.gz",
    qrelsId: "example",
    qrelsUrl:
      "https://raw.githubusercontent.com/castorini/anserini-tools/master/topics-and-qrels/qrels.example.txt",
  });

  const previousRoot = process.env.PIIKA_BENCHMARKS_DIR;
  process.env.PIIKA_BENCHMARKS_DIR = join(root, "data", "prebuilt");
  try {
    assert.equal(getBenchmarkDefinition(plan.benchmarkId).datasetId, "example-corpus");
    const resolved = resolveBenchmarkConfig({ benchmarkId: plan.benchmarkId });
    assert.equal(resolved.querySetId, "example-test");
    assert.match(resolved.queryPath, /queries\.tsv$/);
    assert.match(resolved.qrelsPath, /qrels\.txt$/);

    const conflictingManifest = JSON.parse(readFileSync(plan.manifestPath, "utf8")) as {
      aliases: string[];
    };
    conflictingManifest.aliases = ["browsecomp-plus"];
    writeFileSync(plan.manifestPath, JSON.stringify(conflictingManifest));
    assert.throws(
      () => getBenchmarkDefinition(plan.benchmarkId),
      /Benchmark name or alias browsecomp-plus is shared/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.PIIKA_BENCHMARKS_DIR;
    else process.env.PIIKA_BENCHMARKS_DIR = previousRoot;
  }
});

void test("prebuilt setup retries index mirrors and records the successful URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "piika-prebuilt-mirror-"));
  const archiveSource = join(root, "archive-source");
  const archivePath = join(root, "example.tar.gz");
  mkdirSync(archiveSource);
  writeFileSync(join(archiveSource, "segments_1"), "index data");
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", archiveSource, "."]);
  assert.equal(tar.status, 0, tar.stderr.toString());
  const archive = readFileSync(archivePath);

  const mirrorCatalog = structuredClone(catalog);
  mirrorCatalog.indexes[0].urls = [
    "https://primary.example/index.tar.gz",
    "https://mirror.example/index.tar.gz",
  ];
  mirrorCatalog.indexes[0].md5 = createHash("md5").update(archive).digest("hex");
  mkdirSync(join(root, "vendor", "anserini"), { recursive: true });
  writeFileSync(join(root, "vendor", "anserini", "anserini-1.6.0-fatjar.jar"), "jar");

  const requests: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("topics.example.tsv.gz")) {
      return new Response(gzipSync("q1\texample query\n"));
    }
    if (url.endsWith("qrels.example.txt")) return new Response("q1 0 d1 1\n");
    if (url === "https://primary.example/index.tar.gz") {
      return new Response("corrupt archive");
    }
    if (url === "https://mirror.example/index.tar.gz") return new Response(archive);
    return new Response("missing", { status: 404 });
  };

  const plan = await setupPrebuiltBenchmark({
    rootDir: root,
    indexId: "example-index",
    topicsId: "example-test",
    catalog: mirrorCatalog,
    fetchImpl,
  });

  assert.deepEqual(requests.slice(-2), mirrorCatalog.indexes[0].urls);
  assert.equal(plan.indexUrl, "https://mirror.example/index.tar.gz");
  assert.equal(existsSync(join(plan.indexPath, "segments_1")), true);
  const manifest = JSON.parse(readFileSync(plan.manifestPath, "utf8")) as {
    source: { indexUrl: string };
  };
  assert.equal(manifest.source.indexUrl, "https://mirror.example/index.tar.gz");
});

void test("installed benchmark loader rejects malformed manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "piika-prebuilt-invalid-"));
  const installDir = join(root, "invalid");
  mkdirSync(installDir);
  writeFileSync(
    join(installDir, "benchmark.json"),
    JSON.stringify({ id: "invalid", aliases: [42] }),
  );
  assert.throws(
    () => loadInstalledBenchmarks(root),
    /Installed benchmark manifest is missing required fields/,
  );
});
