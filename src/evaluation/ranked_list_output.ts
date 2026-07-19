import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const RANKED_LIST_TREC_FILENAME = "ranked_list.trec";
export const DEFAULT_RANKED_LIST_DEPTH = 1000;

export type RankedListParseResult = {
  docids: string[];
  error?: string;
};

type RankedListRunRecord = {
  query_id?: unknown;
  ranked_docids?: unknown;
};

function normalizeDocid(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`,;]+$/g, "");
}

function extractDocidFromRankedLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const rankedMatch = trimmed.match(/^(?:[-*]\s*)?(?:\d+[).\]:-]|\d+\s+)\s*(.+)$/u);
  const candidate = rankedMatch?.[1] ?? trimmed.match(/^docid\s*[:=]\s*(.+)$/iu)?.[1];
  if (!candidate) return null;

  const docid =
    candidate.match(/^(?:docid\s*[:=]\s*)?([^\s,;|\])]+)/iu)?.[1] ??
    candidate.match(/["'`]([^"'`\s]+)["'`]/u)?.[1];
  return docid ? normalizeDocid(docid) : null;
}

function extractJsonDocids(text: string): string[] | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const values = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? ((parsed as { ranked_docids?: unknown; docids?: unknown; ranking?: unknown })
              .ranked_docids ??
            (parsed as { docids?: unknown }).docids ??
            (parsed as { ranking?: unknown }).ranking)
          : undefined;
      if (!Array.isArray(values)) continue;
      return values
        .map((value) => {
          if (typeof value === "string" || typeof value === "number") return String(value);
          if (typeof value === "object" && value !== null) {
            const raw = (value as { docid?: unknown }).docid;
            if (typeof raw === "string" || typeof raw === "number") return String(raw);
          }
          return "";
        })
        .map(normalizeDocid)
        .filter(Boolean);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function parseRankedDocidsFromAssistantText(text: string): RankedListParseResult {
  const rankedSection = text.match(/(?:^|\n)Ranked List:\s*\n([\s\S]*)$/iu)?.[1] ?? text;
  const fromJson = extractJsonDocids(rankedSection);
  const rawDocids =
    fromJson ??
    rankedSection
      .split(/\r?\n/)
      .map(extractDocidFromRankedLine)
      .filter((docid): docid is string => Boolean(docid));

  const uniqueDocids: string[] = [];
  const seen = new Set<string>();
  for (const docid of rawDocids) {
    if (seen.has(docid)) continue;
    seen.add(docid);
    uniqueDocids.push(docid);
  }

  return uniqueDocids.length > 0
    ? { docids: uniqueDocids }
    : { docids: [], error: "No ranked docids could be parsed from the final assistant text." };
}

function getRunJsonPaths(runDir: string): string[] {
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(runDir, entry.name))
    .filter(
      (path) =>
        !path.endsWith("/benchmark_manifest_snapshot.json") && !path.endsWith("/run_setup.json"),
    )
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

export function formatTrecRunLines(options: {
  queryId: string;
  docids: string[];
  runTag: string;
}): string[] {
  return options.docids.map((docid, index) => {
    const rank = index + 1;
    const score = options.docids.length - index;
    return `${options.queryId} Q0 ${docid} ${rank} ${score} ${options.runTag}`;
  });
}

export function writeRankedListTrecRunFile(options: {
  runDir: string;
  outputPath?: string;
  runTag?: string;
}): { outputPath: string; queryCount: number; lineCount: number } {
  const outputPath = resolve(
    options.outputPath ?? resolve(options.runDir, RANKED_LIST_TREC_FILENAME),
  );
  const runTag = options.runTag ?? "pi-agent";
  const lines: string[] = [];
  let queryCount = 0;

  for (const path of getRunJsonPaths(options.runDir)) {
    const run = JSON.parse(readFileSync(path, "utf8")) as RankedListRunRecord;
    const queryId =
      typeof run.query_id === "string" || typeof run.query_id === "number"
        ? String(run.query_id)
        : "";
    if (!queryId || !Array.isArray(run.ranked_docids)) continue;
    const docids = run.ranked_docids
      .filter(
        (docid): docid is string | number => typeof docid === "string" || typeof docid === "number",
      )
      .map((docid) => String(docid));
    if (docids.length === 0) continue;
    queryCount += 1;
    lines.push(...formatTrecRunLines({ queryId, docids, runTag }));
  }

  writeFileSync(outputPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return { outputPath, queryCount, lineCount: lines.length };
}
