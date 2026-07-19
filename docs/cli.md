# piika CLI

This document describes the `piika` command exposed by the npm package.

The CLI is a thin wrapper around the existing TypeScript operator entrypoints. It keeps the public command surface shorter than the full `npm run ...` script list while preserving the same benchmark defaults, manifest resolution, and downstream artifact behavior.

## Install and inspect

From a published npm package:

```bash
npm install -g @castorini/piika
piika --help
piika --version
```

From a local package tarball:

```bash
npm pack
npm install -g ./castorini-piika-<version>.tgz
piika --help
```

For source-checkout development, use the bin script directly:

```bash
node bin/piika.js --help
```

## Commands

The first CLI release supports:

```bash
piika benchmarks
piika prebuilt <indexes|topics|qrels|setup> [options]
piika setup <benchmark> [options]
piika run [--mode single|shared|sharded] [options]
piika run --preset <preset> [options]
piika status [options]
piika tui [options]
piika summarize <run-dir> [options]
piika eval retrieval <run-dir> [options]
piika eval judge <run-dir> [options]
piika report <run-dir> [options]
```

Most options are forwarded to the underlying TypeScript entrypoint, so existing flags such as `--benchmark`, `--query-set`, `--model`, `--dry-run`, `--qrels`, and `--output-dir` continue to work.

## Benchmark catalog

Use `benchmarks` to list registered benchmark ids, query sets, setup steps, retrieval backends, judge modes, and managed presets:

```bash
piika benchmarks
```

This is the CLI equivalent of:

```bash
npm run bench -- benchmarks
```

## Castorini prebuilt indexes, topics, and qrels

The prebuilt catalog is loaded at runtime from `castorini/prebuilt-indexes` and
`castorini/anserini-tools`, so a newly published upstream asset does not require a piika release or
another hard-coded benchmark definition.

Search the three catalogs with an optional case-insensitive filter:

```bash
piika prebuilt indexes msmarco
piika prebuilt topics dl19
piika prebuilt qrels dl19
```

Install a compatible index/topic/qrels combination:

```bash
piika prebuilt setup msmarco-v1-passage --topics dl19-passage --dry-run
piika prebuilt setup msmarco-v1-passage --topics dl19-passage
piika prebuilt setup msmarco-v2-passage --topics dl21 --qrels dl21-passage
```

The setup command resolves qrels by topic ID and the official qrels aliases. Override that choice
when necessary:

```bash
piika prebuilt setup <index-id> --topics <topics-id> --qrels <qrels-id>
```

After setup, the command prints the generated benchmark ID. It is also shown by `piika benchmarks`
and works with the normal single, shared, and sharded runners:

```bash
piika run --benchmark prebuilt-msmarco-v1-passage-dl19-passage
```

Downloaded files are kept in the workspace's normal ignored asset locations: archives under
`vendor/downloads/`, indexes under `indexes/`, and installed manifests plus normalized queries and
qrels under `data/prebuilt/`. Piika verifies the index archive against the MD5 published in the
upstream catalog before extraction. Downloads are written atomically, and index mirrors are tried
in catalog order until one downloads with the expected checksum. Existing verified archives and
extracted indexes are reused.

Catalog discovery requires access to the GitHub API and the raw files in `castorini/anserini-tools`.
Setup currently accepts Lucene catalog entries with type `inverted`. Topics using Anserini's TSV,
JSON/JSONL, DPR JSON, and classic TREC readers are normalized to piika's two-column TSV format;
other specialized reader classes fail with an actionable compatibility error.

Each successful setup writes `data/prebuilt/<benchmark-id>/benchmark.json`. These installed
manifests are loaded dynamically by `piika benchmarks`, `piika run`, evaluation, and reporting, so
adding an upstream index or query set does not require a source-code change. Set
`PIIKA_BENCHMARKS_DIR` to use a different installed-manifest directory.

## Setup

Set up benchmark assets with:

```bash
piika setup benchmark-template
piika setup browsecomp-plus
piika setup msmarco-v1-passage
```

Select a non-default setup step with `--step`:

```bash
piika setup browsecomp-plus --step query-slices
piika setup browsecomp-plus --step ground-truth
```

Use `--dry-run` to inspect the resolved setup script without executing it:

```bash
piika setup benchmark-template --dry-run
```

The setup command dispatches through `src/orchestration/setup_benchmark_entry.ts`, then runs the benchmark-specific script declared in the benchmark manifest.

## Run benchmarks

### Single-process mode

Single-process mode is the default:

```bash
piika run \
  --benchmark benchmark-template \
  --query-set test \
  --model openai-codex/gpt-5.4-mini
```

This is equivalent to:

```bash
piika run --mode single ...
```

Use `--dry-run` to print the resolved run plan and downstream command:

```bash
piika run --benchmark benchmark-template --query-set test --dry-run
```

#### Pyserini REST two-tool interface

To run the CLI against a Pyserini REST service, set the Pyserini REST environment variables before invoking `piika run`:

```bash
PYSERINI_REST_BASE_URL=http://127.0.0.1:8081 \
PYSERINI_REST_INDEX=browsecomp-plus \
piika run \
  --benchmark browsecomp-plus \
  --query-set q9
```

When both `PYSERINI_REST_BASE_URL` and `PYSERINI_REST_INDEX` are set, the launcher builds the Pyserini REST `PI_SEARCH_EXTENSION_CONFIG` and selects `PI_SEARCH_TOOL_INTERFACE=pyserini-rest-2tool` automatically. You may set `PI_SEARCH_TOOL_INTERFACE=pyserini-rest-2tool` explicitly, but it is not required for this shortcut.

Optional Pyserini REST environment variables:

```bash
PYSERINI_REST_READ_MODE=paginated              # full or paginated; default shortcut behavior is paginated
PYSERINI_REST_SEARCH_MAX_DOC_LENGTH=500        # max_doc_length for search previews
PYSERINI_REST_TOKEN_ENV=PYSERINI_API_TOKEN     # env var containing a bearer token
```

For authenticated endpoints, either put the token in `PYSERINI_API_TOKEN` or set `PYSERINI_REST_TOKEN_ENV` to another environment variable name that contains the token.

For the full backend configuration details, see `docs/pyserini-rest-search-provider.md`.

### Shared BM25 mode

Shared mode starts one BM25 daemon and runs the selected query set against it:

```bash
piika run \
  --mode shared \
  --benchmark browsecomp-plus \
  --query-set q9 \
  --model openai-codex/gpt-5.4-mini \
  --port 50455
```

Shared mode accepts the same benchmark and path override flags as the lower-level shared BM25 entrypoint. Model, prompt, output, timeout, thinking, and `pi` binary flags are forwarded through environment variables to the nested single-process launcher.

### Sharded shared BM25 mode

Sharded mode splits the query set across workers, runs those workers against a shared BM25 daemon, then merges per-query artifacts:

```bash
piika run \
  --mode sharded \
  --benchmark browsecomp-plus \
  --query-set q100 \
  --shards 4 \
  --model openai-codex/gpt-5.4-mini
```

`--shards` is accepted as a CLI alias for the lower-level `--shard-count` flag.

### Managed presets

Passing `--preset` routes to the supervisor-managed runner:

```bash
piika run \
  --preset browsecomp-plus/qfull_sharded \
  --model openai-codex/gpt-5.4-mini \
  --shards 8
```

Managed presets are listed by:

```bash
piika benchmarks
```

Do not combine `--preset` with `--mode`.

## Monitor runs

Print a textual status snapshot:

```bash
piika status
```

Open the terminal dashboard:

```bash
piika tui
```

These commands use the existing `benchctl` operator surface.

## Downstream artifacts

Summarize a run:

```bash
piika summarize runs/<run>
```

Run retrieval evaluation:

```bash
piika eval retrieval runs/<run>
```

Run judge evaluation:

```bash
piika eval judge runs/<run>
```

Generate a Markdown report:

```bash
piika report runs/<run>
```

Each command also accepts the explicit lower-level path flags:

```bash
piika summarize --run-dir runs/<run>
piika eval retrieval --run-dir runs/<run>
piika eval judge --input-dir runs/<run>
piika report --run-dir runs/<run>
```

Benchmark defaults, qrels resolution, run-manifest detection, and merged-run handling are delegated to the existing wrapper entrypoints.

## Environment variables

The CLI preserves the environment-variable behavior of the underlying entrypoints. Common variables include:

- `BENCHMARK`
- `QUERY_SET`
- `MODEL`
- `THINKING`
- `TIMEOUT_SECONDS`
- `PI_BIN`
- `PI_BM25_RPC_HOST`
- `PI_BM25_RPC_PORT`
- `PI_BM25_K1`
- `PI_BM25_B`
- `PI_BM25_THREADS`
- `PYSERINI_REST_BASE_URL`
- `PYSERINI_REST_INDEX`
- `PYSERINI_REST_TOKEN_ENV`
- `PYSERINI_REST_READ_MODE`
- `PYSERINI_REST_SEARCH_MAX_DOC_LENGTH`
- `PI_SEARCH_EXTENSION_CONFIG`
- `PI_SEARCH_TOOL_INTERFACE`

Flags take precedence where the underlying entrypoint already gives flags precedence.

## Relationship to npm scripts

The CLI is intended as the stable user-facing surface for npm installs. The `npm run ...` scripts remain available for source-checkout workflows, compatibility, and lower-level debugging.

Useful equivalents:

| CLI                              | npm script                                            |
| -------------------------------- | ----------------------------------------------------- |
| `piika benchmarks`               | `npm run bench -- benchmarks`                         |
| `piika setup <benchmark>`        | `npm run setup:benchmark -- --benchmark <benchmark>`  |
| `piika run --mode single`        | `npm run run:benchmark:query-set`                     |
| `piika run --mode shared`        | `npm run run:benchmark:query-set:shared-bm25`         |
| `piika run --mode sharded`       | `npm run run:benchmark:query-set:sharded-shared-bm25` |
| `piika status`                   | `npm run bench -- status`                             |
| `piika tui`                      | `npm run bench:tui`                                   |
| `piika summarize <run-dir>`      | `RUN_DIR=<run-dir> npm run summarize:run`             |
| `piika eval retrieval <run-dir>` | `RUN_DIR=<run-dir> npm run evaluate:retrieval`        |
| `piika eval judge <run-dir>`     | `INPUT_DIR=<run-dir> npm run evaluate:run`            |
| `piika report <run-dir>`         | `RUN_DIR=<run-dir> npm run report:run`                |
