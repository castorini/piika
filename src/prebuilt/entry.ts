import {
  loadPrebuiltCatalog,
  type AnseriniQrels,
  type AnseriniTopic,
  type PrebuiltIndex,
} from "./catalog";
import { resolvePrebuiltSetupPlan, setupPrebuiltBenchmark } from "./setup";

type SetupArgs = {
  indexId?: string;
  topicsId?: string;
  qrelsId?: string;
  dryRun: boolean;
};

function printHelp(): void {
  console.log(`Usage:
  piika prebuilt indexes [filter]
  piika prebuilt topics [filter]
  piika prebuilt qrels [filter]
  piika prebuilt setup <index-id> --topics <topics-id> [--qrels <qrels-id>] [--dry-run]

The catalog is read at runtime from castorini/prebuilt-indexes and castorini/anserini-tools.
Piika's local BM25 backend supports prebuilt indexes whose catalog type is "inverted".

Example:
  piika prebuilt setup msmarco-v1-passage --topics dl19-passage --dry-run
`);
}

function matchesFilter(values: string[], filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(needle));
}

function printIndexes(indexes: PrebuiltIndex[], filter?: string): void {
  for (const index of indexes) {
    if (!matchesFilter([index.name, index.corpus, index.description], filter)) continue;
    const sizeGiB = index.size / 1024 ** 3;
    console.log(`${index.name}\t${index.type}\t${sizeGiB.toFixed(2)} GiB\t${index.corpus}`);
  }
}

function printTopics(topics: AnseriniTopic[], filter?: string): void {
  for (const topic of topics) {
    if (!matchesFilter([topic.id, topic.path, topic.readerClass], filter)) continue;
    console.log(`${topic.id}\t${topic.path}\t${topic.readerClass.split(".").at(-1)}`);
  }
}

function printQrels(qrels: AnseriniQrels[], filter?: string): void {
  for (const entry of qrels) {
    if (!matchesFilter([entry.id, entry.path, ...entry.aliases], filter)) continue;
    console.log(
      `${entry.id}\t${entry.path}${entry.aliases.length ? `\taliases=${entry.aliases.join(",")}` : ""}`,
    );
  }
}

function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!arg.startsWith("-") && !args.indexId) {
      args.indexId = arg;
      continue;
    }
    switch (arg) {
      case "--index":
        if (!next) throw new Error(`${arg} requires a value`);
        args.indexId = next;
        index += 1;
        break;
      case "--topics":
        if (!next) throw new Error(`${arg} requires a value`);
        args.topicsId = next;
        index += 1;
        break;
      case "--qrels":
        if (!next) throw new Error(`${arg} requires a value`);
        args.qrelsId = next;
        index += 1;
        break;
      case "--dry-run":
      case "--dryRun":
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown setup argument: ${arg}`);
    }
  }
  if (!args.indexId) throw new Error("prebuilt setup requires an index id");
  if (!args.topicsId) throw new Error("prebuilt setup requires --topics <topics-id>");
  return args;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "indexes" || command === "topics" || command === "qrels") {
    const catalog = await loadPrebuiltCatalog();
    const filter = args[0];
    if (args.length > 1) throw new Error(`${command} accepts at most one filter argument`);
    if (command === "indexes") printIndexes(catalog.indexes, filter);
    if (command === "topics") printTopics(catalog.topics, filter);
    if (command === "qrels") printQrels(catalog.qrels, filter);
    return;
  }
  if (command === "setup") {
    const setupArgs = parseSetupArgs(args);
    const options = {
      indexId: setupArgs.indexId as string,
      topicsId: setupArgs.topicsId as string,
      qrelsId: setupArgs.qrelsId,
      dryRun: setupArgs.dryRun,
    };
    const plan = setupArgs.dryRun
      ? (await resolvePrebuiltSetupPlan(options)).plan
      : await setupPrebuiltBenchmark(options);
    console.log(`BENCHMARK=${plan.benchmarkId}`);
    console.log(`INDEX=${plan.indexId}`);
    console.log(`TOPICS=${plan.topicsId}`);
    console.log(`QRELS=${plan.qrelsId}`);
    console.log(`INDEX_URL=${plan.indexUrl}`);
    console.log(`INDEX_PATH=${plan.indexPath}`);
    console.log(`QUERY_PATH=${plan.queryPath}`);
    console.log(`QRELS_PATH=${plan.qrelsPath}`);
    console.log(`MANIFEST_PATH=${plan.manifestPath}`);
    if (!setupArgs.dryRun) {
      console.log(`Run with: piika run --benchmark ${plan.benchmarkId}`);
    }
    return;
  }
  throw new Error(`Unknown prebuilt command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
