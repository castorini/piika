---
name: use-piika
description: Configure, run, evaluate, compare, summarize, and report Piika research and retrieval benchmarks. Use for Piika package setup; built-in, prebuilt, or custom benchmark manifests; local Anserini or remote Pyserini backends; single, shared, or sharded runs; answer, ranked-list, or combined outputs; supplied-document bundles; and reproducible evaluation workflows.
---

# Use Piika

Operate Piika through its package entrypoints and benchmark manifests. Prefer dry runs and manifest-backed defaults so run artifacts preserve the actual experimental condition.

## Establish context

1. Work from the repository root containing `package.json`.
2. Inspect `git status --short --branch`; do not disturb unrelated work.
3. Read `README.md` for the current high-level workflow.
4. Read `docs/cli.md` when using the packaged `piika` CLI or prebuilt indexes.
5. Read `references/workflows.md` for the command and option matrix.
6. Use `--help` and `--dry-run` before unfamiliar or expensive operations.

## Choose the benchmark source

- Use a built-in benchmark when `npm run run:benchmark:query-set -- --help` lists it.
- Use `npm run prebuilt -- setup ...` for a Castorini prebuilt index/topics/qrels combination.
- Use `npm run install:benchmark-manifest -- --manifest <path>` for any other reusable benchmark. Validate first with `--dry-run`.
- Use explicit `--query-file`, `--qrels`, and `--index-path` only for ad hoc experiments where generic benchmark identity in the run manifest is acceptable.

Never add a dataset-specific TypeScript registry entry when an installed manifest expresses the same configuration.

## Choose the backend and topology

- Prefer the default direct `pyserini-rest-2tool` interface for remote Pyserini and ordinary local runs.
- Use `pi-serini-3tool` only to reproduce cached search-result browsing behavior.
- Use the single-process runner for smoke tests and small query sets.
- Use shared BM25 when multiple queries should reuse one local backend.
- Use sharded shared BM25 for parallel production runs.

Confirm that the configured index is reachable before launching a long run. A remote index name is not a local filesystem path.

## Choose outputs

- Use `answer` for question answering.
- Use `ranked_list` for TREC-style document rankings.
- Use `answer+ranked_list` to produce both from one research pass.
- Set `--ranked-list-depth` as a maximum.
- Set `--ranked-list-count` only when an exact list length is an intentional experimental constraint.
- Add `--supplied-doc-bundle` when each query includes preselected evidence. Ensure bundle qids align with qrels and ground truth.

## Execute and verify

1. Print the launch plan with `--dry-run`.
2. Run a small `--limit` smoke test when using a new model, backend, or dataset.
3. Launch the intended full topology.
4. Run retrieval evaluation when qrels exist.
5. Run judge evaluation in `gold-answer` or `reference-free` mode as appropriate.
6. Generate a report from the same run directory.
7. Inspect the run's `benchmark_manifest_snapshot.json` and `run_setup.json` before comparing results.

Treat provider usage limits, missing indexes, judge nonzero exits, malformed ground truth, and qid mismatches as failed setup—not valid benchmark outcomes.
