import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type MultiAnswerGroundTruthOptions = {
  queriesPath: string;
  answersPath: string;
  outputPath: string;
  idField?: string;
  answersField?: string;
};

type ParsedArgs = MultiAnswerGroundTruthOptions & { help?: boolean };

function parseArgs(argv: string[]): ParsedArgs {
  const args: Partial<ParsedArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...args, help: true } as ParsedArgs;
    const next = argv[index + 1];
    if (!next) throw new Error(`${arg} requires a value`);
    if (arg === "--queries") args.queriesPath = next;
    else if (arg === "--answers") args.answersPath = next;
    else if (arg === "--output") args.outputPath = next;
    else if (arg === "--id-field") args.idField = next;
    else if (arg === "--answers-field") args.answersField = next;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  if (!args.queriesPath || !args.answersPath || !args.outputPath) {
    throw new Error("--queries, --answers, and --output are required");
  }
  return args as ParsedArgs;
}

function readAcceptableAnswers(
  answersPath: string,
  idField: string,
  answersField: string,
): Map<string, string[]> {
  const answers = new Map<string, string[]>();
  for (const [index, line] of readFileSync(resolve(answersPath), "utf8")
    .split(/\r?\n/u)
    .entries()) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const rawId = row[idField];
    const rawAnswers = row[answersField];
    if ((typeof rawId !== "string" && typeof rawId !== "number") || !Array.isArray(rawAnswers)) {
      throw new Error(
        `Invalid answer row ${index + 1}: expected ${idField} as string/number and ${answersField} as an array`,
      );
    }
    const queryId = String(rawId);
    if (answers.has(queryId)) {
      throw new Error(`Duplicate answer row for query ${queryId}`);
    }
    const acceptable = Array.from(
      new Set(
        rawAnswers
          .filter((answer): answer is string => typeof answer === "string")
          .map((answer) => answer.trim())
          .filter(Boolean),
      ),
    );
    if (acceptable.length === 0) {
      throw new Error(`No acceptable answers found for query ${queryId}`);
    }
    answers.set(queryId, acceptable);
  }
  return answers;
}

export function prepareMultiAnswerGroundTruth(options: MultiAnswerGroundTruthOptions): {
  outputPath: string;
  rowCount: number;
} {
  const idField = options.idField?.trim() || "qid";
  const answersField = options.answersField?.trim() || "answer";
  const answers = readAcceptableAnswers(options.answersPath, idField, answersField);
  const seenQueries = new Set<string>();
  const outputRows: string[] = [];

  for (const [index, line] of readFileSync(resolve(options.queriesPath), "utf8")
    .split(/\r?\n/u)
    .entries()) {
    if (!line.trim()) continue;
    const [queryId, ...questionParts] = line.split("\t");
    if (!queryId || questionParts.length === 0) {
      throw new Error(`Invalid query row ${index + 1}: expected query_id<TAB>question`);
    }
    if (seenQueries.has(queryId)) {
      throw new Error(`Duplicate query row for query ${queryId}`);
    }
    seenQueries.add(queryId);
    const acceptable = answers.get(queryId);
    if (!acceptable) throw new Error(`No acceptable answers found for query ${queryId}`);
    outputRows.push(
      JSON.stringify({
        query_id: queryId,
        query: questionParts.join("\t"),
        answer: JSON.stringify(acceptable),
      }),
    );
  }

  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${outputRows.join("\n")}\n`, "utf8");
  return { outputPath, rowCount: outputRows.length };
}

function printHelp(): void {
  console.log(`Usage: npm run adapt:multi-answer-ground-truth -- --queries <tsv> --answers <jsonl> --output <jsonl> [options]

Options:
  --queries <path>       TSV rows in query_id<TAB>question format
  --answers <path>       Source JSONL containing an id and an array of acceptable answers
  --output <path>        Piika ground-truth JSONL destination
  --id-field <name>      Source JSONL id field (default: qid)
  --answers-field <name> Source JSONL answers field (default: answer)
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = prepareMultiAnswerGroundTruth(args);
  console.log(`Wrote ${result.rowCount} ground-truth rows to ${result.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
