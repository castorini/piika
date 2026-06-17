#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printHelp() {
  console.log(`piika ${packageJson.version}

Usage:
  piika benchmarks
  piika setup <benchmark> [options]
  piika run [--mode single|shared|sharded] [options]
  piika run --preset <preset> [options]
  piika status [options]
  piika tui [options]
  piika summarize <run-dir> [options]
  piika eval retrieval <run-dir> [options]
  piika eval judge <run-dir> [options]
  piika report <run-dir> [options]

Examples:
  piika benchmarks
  piika setup benchmark-template --dry-run
  piika run --benchmark benchmark-template --query-set test --dry-run
  piika run --mode sharded --benchmark browsecomp-plus --query-set q100 --shards 4
  piika summarize runs/<run>
  piika eval retrieval runs/<run>
  piika eval judge runs/<run>
  piika report runs/<run>
`);
}

function printRunHelp() {
  console.log(`Usage:
  piika run [--mode single|shared|sharded] [options]
  piika run --preset <preset> [options]

Modes:
  single    Run the direct single-process query-set launcher (default)
  shared    Run with a shared BM25 daemon
  sharded   Run sharded workers against a shared BM25 daemon

Managed presets:
  Passing --preset routes to the supervisor-managed runner.

Examples:
  piika run --benchmark benchmark-template --query-set test --dry-run
  piika run --mode shared --benchmark browsecomp-plus --query-set q9
  piika run --mode sharded --benchmark browsecomp-plus --query-set q100 --shards 4
  piika run --preset browsecomp-plus/qfull_sharded --model openai-codex/gpt-5.4-mini
`);
}

function printEvalHelp() {
  console.log(`Usage:
  piika eval retrieval <run-dir> [options]
  piika eval judge <run-dir> [options]
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function buildEnv(overrides = {}) {
  const pathEntries = [resolve(packageRoot, "node_modules", ".bin"), process.env.PATH].filter(
    Boolean,
  );
  return {
    ...process.env,
    ...overrides,
    PATH: pathEntries.join(":"),
  };
}

function runTs(scriptPath, args, envOverrides = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(packageRoot, scriptPath), ...args],
    {
      cwd: packageRoot,
      stdio: "inherit",
      env: buildEnv(envOverrides),
    },
  );

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

function hasOption(args, names) {
  return args.some(
    (arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)),
  );
}

function extractOption(args, names) {
  const rest = [];
  let value;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inlineName = names.find((name) => arg.startsWith(`${name}=`));
    if (inlineName) {
      value = arg.slice(inlineName.length + 1);
      continue;
    }
    if (names.includes(arg)) {
      const next = args[index + 1];
      if (!next) {
        fail(`${arg} requires a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    rest.push(arg);
  }

  return { value, args: rest };
}

function liftOptionsToEnv(args, specs) {
  const rest = [];
  const env = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inlineSpec = specs.find((spec) => spec.names.some((name) => arg.startsWith(`${name}=`)));
    if (inlineSpec) {
      const name = inlineSpec.names.find((optionName) => arg.startsWith(`${optionName}=`));
      env[inlineSpec.env] = arg.slice(name.length + 1);
      continue;
    }

    const spec = specs.find((candidate) => candidate.names.includes(arg));
    if (spec) {
      const next = args[index + 1];
      if (!next) {
        fail(`${arg} requires a value`);
      }
      env[spec.env] = next;
      index += 1;
      continue;
    }

    rest.push(arg);
  }

  return { args: rest, env };
}

function positionalToOption(args, optionName) {
  if (args[0] && !args[0].startsWith("-")) {
    return [optionName, args[0], ...args.slice(1)];
  }
  return args;
}

function normalizeShardedArgs(args) {
  return args.map((arg) => {
    if (arg === "--shards") return "--shard-count";
    if (arg.startsWith("--shards=")) return `--shard-count=${arg.slice("--shards=".length)}`;
    return arg;
  });
}

function runBenchctl(command, args) {
  runTs("src/operator/benchctl.ts", [command, ...args]);
}

function runSetup(args) {
  runTs("src/orchestration/setup_benchmark_entry.ts", positionalToOption(args, "--benchmark"));
}

function runBenchmark(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printRunHelp();
    process.exit(0);
  }

  const modeResult = extractOption(args, ["--mode"]);
  const mode = modeResult.value ?? "single";
  const runArgs = modeResult.args;
  const usesPreset = hasOption(runArgs, ["--preset"]);

  if (usesPreset && mode !== "single") {
    fail("piika run accepts either --preset or --mode, not both.");
  }
  if (usesPreset || mode === "managed") {
    runBenchctl("run", runArgs);
  }

  if (mode === "single") {
    runTs("src/orchestration/query_set.ts", runArgs);
  }
  if (mode === "shared" || mode === "shared-bm25") {
    const lifted = liftOptionsToEnv(runArgs, [
      { names: ["--model"], env: "MODEL" },
      { names: ["--prompt-variant", "--promptVariant"], env: "PROMPT_VARIANT" },
      { names: ["--output-dir", "--outputDir"], env: "OUTPUT_DIR" },
      { names: ["--timeout-seconds", "--timeoutSeconds"], env: "TIMEOUT_SECONDS" },
      { names: ["--thinking"], env: "THINKING" },
      { names: ["--pi"], env: "PI_BIN" },
    ]);
    runTs("src/orchestration/query_set_shared_bm25.ts", lifted.args, lifted.env);
  }
  if (mode === "sharded" || mode === "sharded-shared-bm25") {
    runTs("src/orchestration/query_set_sharded_shared_bm25.ts", normalizeShardedArgs(runArgs));
  }

  fail(`Unsupported run mode: ${mode}. Expected single, shared, sharded, or managed.`);
}

function runSummarize(args) {
  runTs("src/wrappers/summarize_run_entry.ts", positionalToOption(args, "--run-dir"));
}

function runEval(args) {
  const [kind, ...rest] = args;
  if (!kind || kind === "--help" || kind === "-h") {
    printEvalHelp();
    process.exit(0);
  }
  if (kind === "retrieval") {
    runTs("src/wrappers/evaluate_retrieval_entry.ts", positionalToOption(rest, "--run-dir"));
  }
  if (kind === "judge") {
    runTs("src/wrappers/evaluate_run_with_pi_entry.ts", positionalToOption(rest, "--input-dir"));
  }
  fail(`Unsupported eval command: ${kind}. Expected retrieval or judge.`);
}

function runReport(args) {
  runTs("src/wrappers/report_run_markdown_entry.ts", positionalToOption(args, "--run-dir"));
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}
if (command === "--version" || command === "-v") {
  console.log(packageJson.version);
  process.exit(0);
}
if (command === "benchmarks") runBenchctl("benchmarks", args);
if (command === "status") runBenchctl("status", args);
if (command === "tui") runBenchctl("tui", args);
if (command === "setup") runSetup(args);
if (command === "run") runBenchmark(args);
if (command === "summarize") runSummarize(args);
if (command === "eval") runEval(args);
if (command === "report") runReport(args);

fail(`Unknown command: ${command}. Run piika --help for usage.`);
