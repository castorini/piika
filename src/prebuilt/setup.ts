import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import type { BenchmarkDefinition } from "../benchmarks/types";
import { getInstalledBenchmarkRoot } from "../benchmarks/installed";
import {
  ANSERINI_TOOLS_RAW_ROOT,
  findAnseriniQrels,
  findAnseriniTopic,
  findPrebuiltIndex,
  loadPrebuiltCatalog,
  type AnseriniTopic,
  type FetchLike,
  type PrebuiltCatalog,
} from "./catalog";

const DEFAULT_ANSERINI_FATJAR_URL =
  "https://repo1.maven.org/maven2/io/anserini/anserini/1.6.0/anserini-1.6.0-fatjar.jar";

export type PrebuiltSetupOptions = {
  indexId: string;
  topicsId: string;
  qrelsId?: string;
  rootDir?: string;
  catalog?: PrebuiltCatalog;
  fetchImpl?: FetchLike;
  anseriniToolsRawRoot?: string;
  dryRun?: boolean;
};

export type PrebuiltSetupPlan = {
  benchmarkId: string;
  indexId: string;
  topicsId: string;
  qrelsId: string;
  indexUrl: string;
  indexUrls: string[];
  topicsUrl: string;
  qrelsUrl: string;
  archivePath: string;
  indexPath: string;
  rawTopicsPath: string;
  queryPath: string;
  qrelsPath: string;
  manifestPath: string;
  anseriniJarPath: string;
};

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot create a benchmark id from: ${value}`);
  return normalized;
}

function resolveWithin(root: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new Error(`${label} must be a relative path: ${path}`);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its destination directory: ${path}`);
  }
  return resolvedPath;
}

function decodeAsset(path: string, bytes: Buffer): Buffer {
  return path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

function normalizeTsv(text: string): string {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return `${lines
    .map((line, index) => {
      const tab = line.indexOf("\t");
      if (tab <= 0) throw new Error(`Invalid Anserini TSV topic line ${index + 1}`);
      return `${line.slice(0, tab)}\t${line.slice(tab + 1)}`;
    })
    .join("\n")}\n`;
}

function normalizeJsonLines(text: string): string {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return `${lines
    .map((line, index) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      const id = value.id ?? value.query_id ?? value.qid ?? value._id;
      const query = value.title ?? value.query ?? value.question ?? value.text;
      if ((typeof id !== "string" && typeof id !== "number") || typeof query !== "string") {
        throw new Error(`Unsupported Anserini JSON topic record at line ${index + 1}`);
      }
      return `${String(id)}\t${query.replace(/\r?\n/g, " ")}`;
    })
    .join("\n")}\n`;
}

function normalizeTrecTopics(text: string): string {
  const rows: string[] = [];
  for (const block of text.matchAll(/<top>([\s\S]*?)<\/top>/gi)) {
    const body = block[1];
    const idMatch = body.match(/<num>\s*(?:Number:\s*)?([^\s<]+)/i);
    const titleMatch = body.match(/<title>\s*([^\r\n<]+)/i);
    if (idMatch && titleMatch) rows.push(`${idMatch[1]}\t${titleMatch[1].trim()}`);
  }
  if (rows.length === 0) throw new Error("Could not parse any <top> records from Anserini topics");
  return `${rows.join("\n")}\n`;
}

/** Converts a supported Anserini topic file into piika's `query-id<TAB>query` format. */
export function normalizeAnseriniTopics(topic: AnseriniTopic, bytes: Buffer): string {
  const text = decodeAsset(topic.path, bytes).toString("utf8");
  if (
    topic.readerClass.endsWith("TsvIntTopicReader") ||
    topic.readerClass.endsWith("TsvStringTopicReader")
  ) {
    return normalizeTsv(text);
  }
  if (topic.readerClass.includes("Json") || topic.readerClass.includes("Dpr")) {
    return normalizeJsonLines(text);
  }
  if (topic.readerClass.endsWith("TrecTopicReader")) {
    return normalizeTrecTopics(text);
  }
  throw new Error(
    `Piika cannot yet normalize ${topic.readerClass} topics (${topic.id}). Choose a TSV, JSONL, or TREC topic set.`,
  );
}

function supportsTopicReader(topic: AnseriniTopic): boolean {
  return (
    topic.readerClass.endsWith("TsvIntTopicReader") ||
    topic.readerClass.endsWith("TsvStringTopicReader") ||
    topic.readerClass.includes("Json") ||
    topic.readerClass.includes("Dpr") ||
    topic.readerClass.endsWith("TrecTopicReader")
  );
}

async function downloadFile(fetchImpl: FetchLike, url: string, path: string): Promise<void> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "piika-prebuilt-setup" } });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporaryPath = `${path}.part-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
      createWriteStream(temporaryPath, { flags: "wx" }),
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
    throw error;
  }
}

async function downloadFromMirrors(
  fetchImpl: FetchLike,
  urls: string[],
  path: string,
  expectedMd5: string,
): Promise<string> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      await downloadFile(fetchImpl, url, path);
      await verifyMd5(path, expectedMd5);
      return url;
    } catch (error) {
      if (existsSync(path)) rmSync(path);
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All prebuilt index download URLs failed:\n${failures.join("\n")}`);
}

async function verifyMd5(path: string, expected: string): Promise<void> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const actual = hash.digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Index archive MD5 mismatch: expected ${expected}, received ${actual}`);
  }
}

function extractArchive(archivePath: string, indexPath: string): void {
  const listing = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`Unable to inspect index archive: ${listing.stderr}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
  ) {
    throw new Error("Index archive is empty or contains an unsafe path");
  }
  const indexesRoot = resolve(indexPath, "..");
  mkdirSync(indexesRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(indexesRoot, ".piika-extract-"));
  try {
    const extracted = spawnSync("tar", ["-xf", archivePath, "-C", tempDir], {
      encoding: "utf8",
    });
    if (extracted.status !== 0)
      throw new Error(`Unable to extract index archive: ${extracted.stderr}`);
    const children = readdirSync(tempDir);
    if (children.length === 1 && statSync(resolve(tempDir, children[0])).isDirectory()) {
      renameSync(resolve(tempDir, children[0]), indexPath);
      rmSync(tempDir, { recursive: true });
    } else {
      renameSync(tempDir, indexPath);
    }
  } catch (error) {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
    throw error;
  }
}

/** Resolves all local paths and upstream assets without writing to disk. */
export async function resolvePrebuiltSetupPlan(
  options: PrebuiltSetupOptions,
): Promise<{ plan: PrebuiltSetupPlan; catalog: PrebuiltCatalog }> {
  const rootDir = resolve(
    options.rootDir ?? process.env.PIIKA_WORKSPACE_ROOT?.trim() ?? process.cwd(),
  );
  const catalog =
    options.catalog ??
    (await loadPrebuiltCatalog({
      fetchImpl: options.fetchImpl,
      anseriniToolsRawRoot: options.anseriniToolsRawRoot,
    }));
  const index = findPrebuiltIndex(catalog, options.indexId);
  if (index.type !== "inverted") {
    throw new Error(
      `Prebuilt index ${index.name} has type ${index.type}; piika's BM25 backend requires type inverted`,
    );
  }
  const topic = findAnseriniTopic(catalog, options.topicsId);
  if (!supportsTopicReader(topic)) {
    throw new Error(
      `Piika cannot yet normalize ${topic.readerClass} topics (${topic.id}). Choose a TSV, JSONL, or TREC topic set.`,
    );
  }
  const qrels = findAnseriniQrels(catalog, options.qrelsId ?? options.topicsId);
  const qrelsSuffix =
    options.qrelsId && options.qrelsId !== options.topicsId ? `-${slug(qrels.id)}` : "";
  const benchmarkId = `prebuilt-${slug(index.name)}-${slug(topic.id)}${qrelsSuffix}`;
  const installRoot = options.rootDir
    ? resolve(rootDir, "data", "prebuilt")
    : getInstalledBenchmarkRoot();
  const installDir = resolve(installRoot, benchmarkId);
  const archiveName = basename(index.filename);
  if (!archiveName || archiveName === "." || archiveName === "..") {
    throw new Error(`Unsafe prebuilt index filename: ${index.filename}`);
  }
  const rawRoot = (options.anseriniToolsRawRoot ?? ANSERINI_TOOLS_RAW_ROOT).replace(/\/$/, "");
  return {
    catalog,
    plan: {
      benchmarkId,
      indexId: index.name,
      topicsId: topic.id,
      qrelsId: qrels.id,
      indexUrl: index.urls[0],
      indexUrls: [...index.urls],
      topicsUrl: `${rawRoot}/${topic.path}`,
      qrelsUrl: `${rawRoot}/${qrels.path}`,
      archivePath: resolve(rootDir, "vendor", "downloads", archiveName),
      indexPath: resolveWithin(resolve(rootDir, "indexes"), index.name, "Prebuilt index id"),
      rawTopicsPath: resolveWithin(resolve(installDir, "source"), topic.path, "Topics path"),
      queryPath: resolve(installDir, "queries.tsv"),
      qrelsPath: resolve(installDir, "qrels.txt"),
      manifestPath: resolve(installDir, "benchmark.json"),
      anseriniJarPath: resolve(rootDir, "vendor", "anserini", "anserini-1.6.0-fatjar.jar"),
    },
  };
}

/** Downloads, verifies, installs, and registers a Castorini benchmark combination. */
export async function setupPrebuiltBenchmark(
  options: PrebuiltSetupOptions,
): Promise<PrebuiltSetupPlan> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { plan, catalog } = await resolvePrebuiltSetupPlan(options);
  if (options.dryRun) return plan;
  const index = findPrebuiltIndex(catalog, options.indexId);
  const topic = findAnseriniTopic(catalog, options.topicsId);

  await downloadFile(fetchImpl, plan.topicsUrl, plan.rawTopicsPath);
  const qrelsSourcePath = resolve(plan.qrelsPath, "..", "source-qrels");
  await downloadFile(fetchImpl, plan.qrelsUrl, qrelsSourcePath);
  mkdirSync(resolve(plan.manifestPath, ".."), { recursive: true });
  writeFileSync(
    plan.queryPath,
    normalizeAnseriniTopics(topic, readFileSync(plan.rawTopicsPath)),
    "utf8",
  );
  writeFileSync(
    plan.qrelsPath,
    decodeAsset(findAnseriniQrels(catalog, plan.qrelsId).path, readFileSync(qrelsSourcePath)),
  );
  rmSync(qrelsSourcePath);

  if (!existsSync(plan.anseriniJarPath)) {
    await downloadFile(
      fetchImpl,
      process.env.ANSERINI_FATJAR_URL?.trim() || DEFAULT_ANSERINI_FATJAR_URL,
      plan.anseriniJarPath,
    );
  }
  if (!existsSync(plan.indexPath)) {
    if (!existsSync(plan.archivePath)) {
      plan.indexUrl = await downloadFromMirrors(
        fetchImpl,
        plan.indexUrls,
        plan.archivePath,
        index.md5,
      );
    }
    await verifyMd5(plan.archivePath, index.md5);
    extractArchive(plan.archivePath, plan.indexPath);
  }

  const manifest: BenchmarkDefinition = {
    id: plan.benchmarkId,
    aliases: [`prebuilt/${plan.indexId}/${plan.topicsId}`],
    displayName: `${index.corpus} (${plan.topicsId}; ${plan.indexId})`,
    datasetId: index.corpus_index,
    piSearchPromptVariant: "plain_minimal",
    defaultQuerySetId: plan.topicsId,
    defaultQueryPath: plan.queryPath,
    querySets: {
      [plan.topicsId]: {
        queryPath: plan.queryPath,
        qrelsPath: plan.qrelsPath,
        indexPath: plan.indexPath,
      },
    },
    defaultQrelsPath: plan.qrelsPath,
    defaultIndexPath: plan.indexPath,
    managedPresets: {},
    setup: { steps: {} },
    retrievalEvaluation: {
      runFileBackend: "trec_eval",
      runDirBackend: "internal",
    },
    judgeEvaluation: {
      supportedModes: ["reference-free"],
      defaultMode: "reference-free",
    },
    source: {
      kind: "castorini-prebuilt",
      indexId: plan.indexId,
      indexUrl: plan.indexUrl,
      indexMd5: index.md5,
      topicsId: plan.topicsId,
      topicsUrl: plan.topicsUrl,
      qrelsId: plan.qrelsId,
      qrelsUrl: plan.qrelsUrl,
    },
  };
  writeFileSync(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return plan;
}
