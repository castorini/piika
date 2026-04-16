import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import { createBenchmarkManifestSnapshot, resolveBenchmarkConfig } from "../benchmarks/registry";
import { resolveGitCommitProvenance } from "../runtime/git";
import { readQueryIds } from "../evaluation/retrieval_metrics";

type SourceResultEntry = {
  type?: string;
  tool_name?: string | null;
  arguments?: unknown;
  output?: unknown;
};

type SourceRunRecord = {
  query_id: string | number;
  result?: SourceResultEntry[];
  status?: string;
  search_counts?: number;
};

type SearchHit = {
  docid?: string | number;
};

type ImportOptions = {
  inputJsonl: string;
  outputDir: string;
  benchmarkId: string;
  querySetId?: string;
  model?: string;
};

type QuerySetCandidate = {
  querySetId: string;
  queryIds: string[];
};

function parseArgs(argv: string[]): ImportOptions {
  const args: ImportOptions = {
    inputJsonl: "",
    outputDir: "",
    benchmarkId: "browsecomp-plus",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--input-jsonl":
      case "--inputJsonl":
        if (!next) throw new Error(`${arg} requires a value`);
        args.inputJsonl = next;
        index += 1;
        break;
      case "--output-dir":
      case "--outputDir":
        if (!next) throw new Error(`${arg} requires a value`);
        args.outputDir = next;
        index += 1;
        break;
      case "--benchmark":
        if (!next) throw new Error(`${arg} requires a value`);
        args.benchmarkId = next;
        index += 1;
        break;
      case "--query-set":
      case "--querySet":
        if (!next) throw new Error(`${arg} requires a value`);
        args.querySetId = next;
        index += 1;
        break;
      case "--model":
        if (!next) throw new Error(`${arg} requires a value`);
        args.model = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.inputJsonl) throw new Error("--input-jsonl is required");
  if (!args.outputDir) throw new Error("--output-dir is required");
  return args;
}

function printHelpAndExit(): never {
  console.log(`Usage: npx tsx src/adapters/import_search_jsonl_run.ts --input-jsonl <path> --output-dir <dir> [options]

Options:
  --benchmark <id>           Benchmark id (default: browsecomp-plus)
  --query-set <id>           Explicit benchmark query set id; otherwise inferred from query ids
  --model <name>             Model label to persist into metadata/run_setup (default: input filename stem)

Semantics:
  Imports one-JSON-object-per-line search-run artifacts into this repo's normalized per-query run directory format.
  Each tool_call search output is treated as model-visible ranked evidence, so surfaced_docids and previewed_docids
  are both the deduplicated first-encounter sequence across all search calls for that query.
`);
  process.exit(0);
}

function parseSearchHits(output: unknown): SearchHit[] {
  if (typeof output !== "string" || !output.trim()) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? (parsed as SearchHit[]) : [];
  } catch {
    return [];
  }
}

function collectToolCallCounts(result: SourceResultEntry[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of result) {
    if (entry.type !== "tool_call" || typeof entry.tool_name !== "string" || !entry.tool_name) {
      continue;
    }
    counts.set(entry.tool_name, (counts.get(entry.tool_name) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectSurfacedDocids(result: SourceResultEntry[]): string[] {
  const docids: string[] = [];
  const seen = new Set<string>();
  for (const entry of result) {
    if (entry.type !== "tool_call" || entry.tool_name !== "search") continue;
    for (const hit of parseSearchHits(entry.output)) {
      const docid =
        typeof hit?.docid === "string" || typeof hit?.docid === "number" ? String(hit.docid) : null;
      if (!docid || seen.has(docid)) continue;
      seen.add(docid);
      docids.push(docid);
    }
  }
  return docids;
}

async function readQueryTextMap(queryPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const reader = createInterface({
    input: createReadStream(resolve(queryPath), { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;
    const [queryId, ...rest] = line.split("\t");
    if (!queryId || rest.length === 0) continue;
    map.set(queryId, rest.join("\t").trim());
  }
  return map;
}

function sameQuerySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== right.length) return false;
  return left.every((queryId) => rightSet.has(queryId));
}

function isSubsetQuerySet(subset: string[], superset: string[]): boolean {
  const supersetIds = new Set(superset);
  return subset.every((queryId) => supersetIds.has(queryId));
}

function resolveQuerySetCandidates(benchmarkId: string): QuerySetCandidate[] {
  const benchmarkConfig = resolveBenchmarkConfig({ benchmarkId });
  return Object.keys(benchmarkConfig.benchmark.querySets).map((querySetId) => {
    const config = resolveBenchmarkConfig({ benchmarkId, querySetId });
    return {
      querySetId: config.querySetId,
      queryIds: readQueryIds(resolve(config.queryPath)),
    };
  });
}

export function inferQuerySetId(benchmarkId: string, sourceQueryIds: string[]): string {
  const candidates = resolveQuerySetCandidates(benchmarkId);
  const exactMatch = candidates.find((candidate) =>
    sameQuerySet(sourceQueryIds, candidate.queryIds),
  );
  if (exactMatch) return exactMatch.querySetId;

  const containingCandidates = candidates
    .filter((candidate) => isSubsetQuerySet(sourceQueryIds, candidate.queryIds))
    .sort((left, right) => left.queryIds.length - right.queryIds.length);
  if (containingCandidates.length > 0) {
    return containingCandidates[0].querySetId;
  }

  throw new Error(
    `Could not infer query set for benchmark ${benchmarkId} from ${sourceQueryIds.length} query ids. Pass --query-set explicitly.`,
  );
}

export async function importSearchJsonlRun(options: ImportOptions): Promise<{
  benchmarkId: string;
  querySetId: string;
  outputDir: string;
  queryCount: number;
}> {
  const inputJsonl = resolve(options.inputJsonl);
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const sourceRecords: SourceRunRecord[] = [];
  const reader = createInterface({
    input: createReadStream(inputJsonl, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;
    sourceRecords.push(JSON.parse(line) as SourceRunRecord);
  }
  if (sourceRecords.length === 0) {
    throw new Error(`Input JSONL is empty: ${inputJsonl}`);
  }

  const sourceQueryIds = sourceRecords.map((record) => String(record.query_id));
  if (new Set(sourceQueryIds).size !== sourceQueryIds.length) {
    throw new Error(`Input JSONL contains duplicate query ids: ${inputJsonl}`);
  }
  const querySetId = options.querySetId ?? inferQuerySetId(options.benchmarkId, sourceQueryIds);
  const benchmarkConfig = resolveBenchmarkConfig({
    benchmarkId: options.benchmarkId,
    querySetId,
  });
  const queryTexts = await readQueryTextMap(benchmarkConfig.queryPath);
  const model = options.model?.trim() || basename(inputJsonl).replace(/\.[^.]+$/, "");

  for (const record of sourceRecords) {
    const queryId = String(record.query_id);
    const result = Array.isArray(record.result) ? record.result : [];
    const surfacedDocids = collectSurfacedDocids(result);
    const toolCallCounts = collectToolCallCounts(result);
    const normalized = {
      query_id: queryId,
      status: record.status ?? "completed",
      result,
      surfaced_docids: surfacedDocids,
      previewed_docids: surfacedDocids,
      tool_call_counts: toolCallCounts,
      metadata: {
        model,
        query: queryTexts.get(queryId) ?? "",
        import_adapter: "search-jsonl-run/v1",
        import_source_path: inputJsonl,
        search_counts: record.search_counts,
      },
    };
    writeFileSync(
      resolve(outputDir, `${queryId}.json`),
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
  }

  const manifest = createBenchmarkManifestSnapshot(benchmarkConfig, resolveGitCommitProvenance());
  writeFileSync(
    resolve(outputDir, "benchmark_manifest_snapshot.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    resolve(outputDir, "run_setup.json"),
    `${JSON.stringify(
      {
        slice: querySetId,
        model,
        queryFile: benchmarkConfig.queryPath,
        qrelsFile: benchmarkConfig.qrelsPath,
        totalQueries: String(sourceRecords.length),
        indexPath: benchmarkConfig.indexPath,
        importSourcePath: inputJsonl,
        importAdapter: "search-jsonl-run/v1",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    benchmarkId: benchmarkConfig.benchmark.id,
    querySetId,
    outputDir,
    queryCount: sourceRecords.length,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await importSearchJsonlRun(args);
  console.log(`Imported ${summary.queryCount} queries into ${summary.outputDir}`);
  console.log(`Benchmark=${summary.benchmarkId}`);
  console.log(`QuerySet=${summary.querySetId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
