import { pathToFileURL } from "node:url";

import { installBenchmarkManifest } from "./installed";

type Args = {
  manifestPath?: string;
  root?: string;
  dryRun: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--manifest":
        if (!next) throw new Error(`${arg} requires a value`);
        args.manifestPath = next;
        index += 1;
        break;
      case "--root":
        if (!next) throw new Error(`${arg} requires a value`);
        args.root = next;
        index += 1;
        break;
      case "--dry-run":
      case "--dryRun":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.manifestPath) throw new Error("--manifest is required");
  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run install:benchmark-manifest -- --manifest <benchmark.json> [options]

Options:
  --manifest <path>  BenchmarkDefinition JSON file to validate and install
  --root <path>      Installed-manifest root (default: PIIKA_BENCHMARKS_DIR or data/prebuilt)
  --dry-run          Validate and print the destination without writing it
  --force            Replace an existing manifest with different contents
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = installBenchmarkManifest({
    sourcePath: args.manifestPath as string,
    root: args.root,
    dryRun: args.dryRun,
    force: args.force,
  });
  console.log(`BENCHMARK=${result.benchmark.id}`);
  console.log(`MANIFEST_PATH=${result.targetPath}`);
  console.log(`WRITTEN=${result.written ? "1" : "0"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
