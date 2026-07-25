import { resolve } from "node:path";
import { readTrecRagQueries, validateTrecRagJsonl } from "./trec_rag_output";

type Args = {
  queries?: string;
  input?: string;
  expectedCount?: number;
  teamId?: string;
  runId?: string;
  runDesc?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  npx tsx src/evaluation/validate_trec_rag_output.ts \\
    --queries <queries.tsv> \\
    --input <rag_output_trec_rag_2026.jsonl> \\
    [--expected-count <n>] [--team-id <id>] [--run-id <id>] [--run-desc <text>]`);
      process.exit(0);
    }
    if (!next) throw new Error(`${arg} requires a value`);
    if (arg === "--queries") args.queries = next;
    else if (arg === "--input") args.input = next;
    else if (arg === "--expected-count") args.expectedCount = Number.parseInt(next, 10);
    else if (arg === "--team-id") args.teamId = next;
    else if (arg === "--run-id") args.runId = next;
    else if (arg === "--run-desc") args.runDesc = next;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.queries) throw new Error("--queries is required");
  if (!args.input) throw new Error("--input is required");
  if (
    args.expectedCount !== undefined &&
    (!Number.isInteger(args.expectedCount) || args.expectedCount <= 0)
  ) {
    throw new Error("--expected-count must be a positive integer");
  }
  const queries = readTrecRagQueries(resolve(args.queries));
  const outputs = validateTrecRagJsonl({
    inputPath: resolve(args.input),
    queries,
    expectedCount: args.expectedCount,
    teamId: args.teamId,
    runId: args.runId,
    runDesc: args.runDesc,
  });
  console.log(`Valid TREC RAG 2026 JSONL: ${resolve(args.input)} records=${outputs.length}`);
}

main();
