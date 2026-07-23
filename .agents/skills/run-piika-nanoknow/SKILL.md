---
name: run-piika-nanoknow
description: Install, run, evaluate, and report NanoKnow NQ-Open or NanoKnow SQuAD through Piika using the ClimbMix-supported query sets and climbmix-400b backend. Use for NanoKnow runs with normal retrieval or supplied-document bundles, multi-answer ground-truth preparation, smoke tests, full runs, and side-by-side experimental comparisons.
---

# Run Piika NanoKnow

Run NanoKnow through generic installed manifests and adapters. Keep NanoKnow-specific paths and commands in this skill; do not add dataset-specific imports to Piika's TypeScript benchmark registry.

## Select the condition

Choose one dataset:

- `nanoknow-nq`: aliases `nq`, `nq-open`; 3,021 ClimbMix-supported queries.
- `nanoknow-squad`: alias `squad`; 9,071 ClimbMix-supported queries.

Choose one evidence condition:

- Retrieval: start from the question and search `climbmix-400b`.
- Supplied documents: inject grouped documents per query, while retaining the backend for narrowly targeted gap filling.

Read `references/end-to-end.md` completely before executing either condition.

## Guardrails

1. Work from the Piika repository root.
2. Inspect the required query, qrels, source-answer, and ground-truth paths.
3. Install the selected asset manifest with the generic installer; use `--dry-run` first.
4. Keep the retrieval and supplied-document conditions in distinct output directories.
5. Use the same model, thinking level, timeout, query population, and backend across a comparison.
6. Run a small `--limit` smoke test before a full dataset.
7. Verify `benchmark_manifest_snapshot.json`, `run_setup.json`, processed-query count, and failure count before evaluation.
8. Never treat missing backend access or provider usage limits as benchmark results.

## Expected outputs

For each condition, produce:

- Native per-query run JSON.
- Retrieval evaluation from the benchmark qrels.
- Gold-answer judge evaluation using all acceptable answers.
- A Markdown report.

When comparing supplied documents against retrieval-only runs, record the supplied bundle path and hash outside ignored data directories if long-term provenance is required.
