import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BenchmarkDefinition } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isQuerySet(value: unknown): boolean {
  if (isNonEmptyString(value)) return true;
  return isRecord(value) && isNonEmptyString(value.queryPath);
}

export function getInstalledBenchmarkRoot(): string {
  return resolve(process.env.PIIKA_BENCHMARKS_DIR?.trim() || "data/prebuilt");
}

export function loadInstalledBenchmarkManifest(path: string): BenchmarkDefinition {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read installed benchmark manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(`Installed benchmark manifest must be an object: ${path}`);
  }
  const manifest = value as Partial<BenchmarkDefinition>;
  if (
    !isNonEmptyString(manifest.id) ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(manifest.id) ||
    !isNonEmptyString(manifest.displayName) ||
    !isNonEmptyString(manifest.datasetId) ||
    manifest.piSearchPromptVariant !== "plain_minimal" ||
    !isNonEmptyString(manifest.defaultQuerySetId) ||
    !isNonEmptyString(manifest.defaultQueryPath) ||
    !isNonEmptyString(manifest.defaultQrelsPath) ||
    !isNonEmptyString(manifest.defaultIndexPath) ||
    !Array.isArray(manifest.aliases) ||
    !manifest.aliases.every(isNonEmptyString) ||
    !isRecord(manifest.querySets) ||
    !Object.values(manifest.querySets).every(isQuerySet) ||
    !isRecord(manifest.managedPresets) ||
    !isRecord(manifest.setup) ||
    !isRecord(manifest.setup.steps) ||
    !isRecord(manifest.retrievalEvaluation) ||
    !["internal", "trec_eval"].includes(String(manifest.retrievalEvaluation.runFileBackend)) ||
    !["internal", "trec_eval"].includes(String(manifest.retrievalEvaluation.runDirBackend))
  ) {
    throw new Error(`Installed benchmark manifest is missing required fields: ${path}`);
  }
  if (!(manifest.defaultQuerySetId in manifest.querySets)) {
    throw new Error(
      `Installed benchmark default query set ${manifest.defaultQuerySetId} is not defined: ${path}`,
    );
  }
  return manifest as BenchmarkDefinition;
}

export function loadInstalledBenchmarks(root = getInstalledBenchmarkRoot()): BenchmarkDefinition[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, "benchmark.json"))
    .filter(existsSync)
    .map(loadInstalledBenchmarkManifest)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveInstalledBenchmarkManifestPath(
  manifest: BenchmarkDefinition,
  root = getInstalledBenchmarkRoot(),
): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, manifest.id, "benchmark.json");
  const relativeTarget = relative(resolvedRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Installed benchmark id escapes the manifest root: ${manifest.id}`);
  }
  return target;
}

export function installBenchmarkManifest(options: {
  sourcePath: string;
  root?: string;
  dryRun?: boolean;
  force?: boolean;
}): { benchmark: BenchmarkDefinition; targetPath: string; written: boolean } {
  const sourcePath = resolve(options.sourcePath);
  const benchmark = loadInstalledBenchmarkManifest(sourcePath);
  const targetPath = resolveInstalledBenchmarkManifestPath(benchmark, options.root);
  const serialized = `${JSON.stringify(benchmark, null, 2)}\n`;
  if (existsSync(targetPath) && readFileSync(targetPath, "utf8") === serialized) {
    return { benchmark, targetPath, written: false };
  }
  if (existsSync(targetPath) && !options.force) {
    throw new Error(
      `Installed benchmark manifest already exists with different contents: ${targetPath}. Pass --force to replace it.`,
    );
  }
  if (!options.dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, serialized, "utf8");
  }
  return { benchmark, targetPath, written: !options.dryRun };
}
