import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TREC_RAG_OUTPUT_FILENAME = "rag_output_trec_rag_2026.jsonl";
export const TREC_RAG_MAX_WORDS = 1024;
export const TREC_RAG_MAX_CITATIONS_PER_SENTENCE = 3;

export type TrecRagQuery = {
  narrativeId: string;
  narrative: string;
};

export type TrecRagAnswerSentence = {
  text: string;
  citations: Array<number | string>;
};

export type TrecRagAnswerPayload = {
  references: string[];
  answer: TrecRagAnswerSentence[];
};

export type TrecRagMetadata = {
  team_id: string;
  narrative_id: string;
  narrative: string;
  run_id: string;
  run_desc: string;
} & Record<string, unknown>;

export type TrecRagOutput = TrecRagAnswerPayload & {
  metadata: TrecRagMetadata;
};

export type TrecRagRunArtifact = {
  status?: unknown;
  query_id?: unknown;
  trec_rag_output?: unknown;
};

const OUTPUT_KEYS = ["answer", "metadata", "references"];
const PAYLOAD_KEYS = ["answer", "references"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly these keys: ${expected.join(", ")}`);
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} is empty`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function parseAnswerPayloadObject(
  value: Record<string, unknown>,
  options?: { exactKeys?: boolean },
): TrecRagAnswerPayload {
  if (options?.exactKeys) assertExactKeys(value, PAYLOAD_KEYS, "answer payload");

  if (!Array.isArray(value.references) || value.references.length === 0) {
    throw new Error("references must be a non-empty array");
  }
  const references = value.references.map((reference, index) =>
    parseNonEmptyString(reference, `references[${index}]`),
  );
  if (new Set(references).size !== references.length) {
    throw new Error("references must contain unique document IDs");
  }

  if (!Array.isArray(value.answer) || value.answer.length === 0) {
    throw new Error("answer must be a non-empty array");
  }

  const answer = value.answer.map((item, answerIndex): TrecRagAnswerSentence => {
    if (!isRecord(item)) throw new Error(`answer[${answerIndex}] must be an object`);
    assertExactKeys(item, ["citations", "text"], `answer[${answerIndex}]`);
    const text = parseNonEmptyString(item.text, `answer[${answerIndex}].text`).trim();
    if (!Array.isArray(item.citations) || item.citations.length === 0) {
      throw new Error(`answer[${answerIndex}].citations must be a non-empty array`);
    }
    if (item.citations.length > TREC_RAG_MAX_CITATIONS_PER_SENTENCE) {
      throw new Error(
        `answer[${answerIndex}].citations exceeds ${TREC_RAG_MAX_CITATIONS_PER_SENTENCE}`,
      );
    }
    const resolvedDocids = new Set<string>();
    const citations = item.citations.map((citation): number | string => {
      if (Number.isInteger(citation)) {
        const citationIndex = citation as number;
        if (citationIndex < 0 || citationIndex >= references.length) {
          throw new Error(
            `answer[${answerIndex}].citations contains out-of-range index ${citationIndex}`,
          );
        }
        const docid = references[citationIndex];
        if (resolvedDocids.has(docid)) {
          throw new Error(`answer[${answerIndex}].citations must not contain duplicates`);
        }
        resolvedDocids.add(docid);
        return citationIndex;
      }
      if (typeof citation === "string" && citation.trim()) {
        if (!references.includes(citation)) {
          throw new Error(
            `answer[${answerIndex}].citations contains document ID missing from references: ${citation}`,
          );
        }
        if (resolvedDocids.has(citation)) {
          throw new Error(`answer[${answerIndex}].citations must not contain duplicates`);
        }
        resolvedDocids.add(citation);
        return citation;
      }
      throw new Error(
        `answer[${answerIndex}].citations must contain zero-based integers or document ID strings`,
      );
    });
    return { text, citations };
  });

  const wordCount = answer.reduce((sum, sentence) => sum + countWords(sentence.text), 0);
  if (wordCount > TREC_RAG_MAX_WORDS) {
    throw new Error(`answer contains ${wordCount} words; maximum is ${TREC_RAG_MAX_WORDS}`);
  }

  return { references, answer };
}

export function useDirectTrecRagDocidCitations(output: TrecRagOutput): TrecRagOutput {
  return {
    metadata: output.metadata,
    references: output.references,
    answer: output.answer.map((sentence) => ({
      text: sentence.text,
      citations: sentence.citations.map((citation) =>
        typeof citation === "number" ? output.references[citation] : citation,
      ),
    })),
  };
}

export function parseTrecRagAnswerPayload(text: string): TrecRagAnswerPayload {
  return parseAnswerPayloadObject(parseJsonObject(text, "assistant output"), { exactKeys: true });
}

export function buildTrecRagOutput(
  payload: TrecRagAnswerPayload,
  metadata: TrecRagMetadata,
): TrecRagOutput {
  return validateTrecRagOutput({ metadata, ...payload });
}

export function validateTrecRagOutput(
  value: unknown,
  expected?: {
    query?: TrecRagQuery;
    teamId?: string;
    runId?: string;
    runDesc?: string;
  },
): TrecRagOutput {
  if (!isRecord(value)) throw new Error("TREC RAG output must be an object");
  assertExactKeys(value, OUTPUT_KEYS, "TREC RAG output");
  if (!isRecord(value.metadata)) throw new Error("metadata must be an object");

  const metadata: TrecRagMetadata = {
    ...value.metadata,
    team_id: parseNonEmptyString(value.metadata.team_id, "metadata.team_id"),
    narrative_id: parseNonEmptyString(value.metadata.narrative_id, "metadata.narrative_id"),
    narrative: parseNonEmptyString(value.metadata.narrative, "metadata.narrative"),
    run_id: parseNonEmptyString(value.metadata.run_id, "metadata.run_id"),
    run_desc: parseNonEmptyString(value.metadata.run_desc, "metadata.run_desc"),
  };
  if (expected?.query && metadata.narrative_id !== expected.query.narrativeId) {
    throw new Error(
      `metadata.narrative_id ${metadata.narrative_id} does not match ${expected.query.narrativeId}`,
    );
  }
  if (expected?.query && metadata.narrative !== expected.query.narrative) {
    throw new Error(`metadata.narrative does not exactly match ${metadata.narrative_id}`);
  }
  if (expected?.teamId && metadata.team_id !== expected.teamId) {
    throw new Error(`metadata.team_id does not match ${expected.teamId}`);
  }
  if (expected?.runId && metadata.run_id !== expected.runId) {
    throw new Error(`metadata.run_id does not match ${expected.runId}`);
  }
  if (expected?.runDesc && metadata.run_desc !== expected.runDesc) {
    throw new Error("metadata.run_desc does not match the configured run description");
  }

  return {
    metadata,
    ...parseAnswerPayloadObject(value),
  };
}

export function readTrecRagQueries(path: string): TrecRagQuery[] {
  const seen = new Set<string>();
  return readFileSync(resolve(path), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      const tab = line.indexOf("\t");
      if (tab < 1) {
        throw new Error(`Invalid query TSV line ${index + 1}: expected narrative_id<TAB>narrative`);
      }
      const narrativeId = line.slice(0, tab);
      const narrative = line.slice(tab + 1);
      if (!narrative) throw new Error(`Narrative is empty on TSV line ${index + 1}`);
      if (seen.has(narrativeId)) throw new Error(`Duplicate narrative ID: ${narrativeId}`);
      seen.add(narrativeId);
      return { narrativeId, narrative };
    });
}

export function validateTrecRagJsonl(options: {
  inputPath: string;
  queries: readonly TrecRagQuery[];
  expectedCount?: number;
  teamId?: string;
  runId?: string;
  runDesc?: string;
}): TrecRagOutput[] {
  const lines = readFileSync(resolve(options.inputPath), "utf8").split(/\r?\n/u).filter(Boolean);
  const expectedCount = options.expectedCount ?? options.queries.length;
  if (lines.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} JSONL records, found ${lines.length}`);
  }
  const selectedQueries = options.queries.slice(0, expectedCount);
  if (selectedQueries.length !== expectedCount) {
    throw new Error(`Only ${selectedQueries.length} source narratives are available`);
  }
  const outputs = lines.map((line, index) =>
    validateTrecRagOutput(parseJsonObject(line, `JSONL line ${index + 1}`), {
      query: selectedQueries[index],
      teamId: options.teamId,
      runId: options.runId,
      runDesc: options.runDesc,
    }),
  );
  const ids = outputs.map((output) => output.metadata.narrative_id);
  if (new Set(ids).size !== ids.length) throw new Error("JSONL contains duplicate narrative IDs");
  return outputs;
}

export function writeTrecRagJsonlFromRunDirectory(options: {
  runDir: string;
  queries: readonly TrecRagQuery[];
  outputPath?: string;
  teamId: string;
  runId: string;
  runDesc: string;
}): { outputPath: string; recordCount: number } {
  const runDir = resolve(options.runDir);
  const outputs = options.queries.map((query) => {
    const artifactPath = resolve(runDir, `${query.narrativeId}.json`);
    if (!existsSync(artifactPath)) throw new Error(`Missing run artifact: ${artifactPath}`);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as TrecRagRunArtifact;
    if (artifact.status !== "completed") {
      throw new Error(`Narrative ${query.narrativeId} has status ${String(artifact.status)}`);
    }
    if (artifact.query_id !== query.narrativeId) {
      throw new Error(`Run artifact query_id mismatch in ${artifactPath}`);
    }
    return useDirectTrecRagDocidCitations(
      validateTrecRagOutput(artifact.trec_rag_output, {
        query,
        teamId: options.teamId,
        runId: options.runId,
        runDesc: options.runDesc,
      }),
    );
  });

  const outputPath = resolve(options.outputPath ?? resolve(runDir, TREC_RAG_OUTPUT_FILENAME));
  const tempPath = `${outputPath}.tmp`;
  rmSync(tempPath, { force: true });
  writeFileSync(
    tempPath,
    `${outputs.map((output) => JSON.stringify(output)).join("\n")}\n`,
    "utf8",
  );
  renameSync(tempPath, outputPath);
  return { outputPath, recordCount: outputs.length };
}
