import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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

function parseInstalledBenchmark(path: string): BenchmarkDefinition {
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
    .map(parseInstalledBenchmark)
    .sort((left, right) => left.id.localeCompare(right.id));
}
