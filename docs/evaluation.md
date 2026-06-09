# Evaluation semantics

This document explains how retrieval evaluation, judge evaluation, normalized summary artifacts, and report labels work in `piika`.

For operator commands, see [running-benchmarks.md](./running-benchmarks.md).
For artifact precedence and provenance, see [reproducibility.md](./reproducibility.md).

## Two evaluation families

The repo supports two different evaluation families:

1. retrieval evaluation
2. judge evaluation

They answer different questions.

Retrieval evaluation measures how well the run surfaced benchmark-relevant documents.
Judge evaluation measures whether the run's final answer appears correct.

These should not be conflated.

## Agent-set retrieval semantics

This repo evaluates multi-turn retrieval agents using the run's final accumulated retrieved-doc sequence for each query.

For a query `q`:

- `A(q)` = the final `retrieved_docids` sequence written by the run
- `G(q)` = the benchmark relevant-doc set from qrels

`A(q)` is built by:

- collecting docids encountered over the full query run
- deduplicating by first occurrence
- preserving first-seen order

This means the retrieval operator is intentionally not evaluating individual tool calls or a post-hoc fused ranking. It evaluates what the agent surfaced across the full interaction.

### Full-sequence coverage metrics

These use the full final agent-set sequence `A(q)`:

- `agent_set_recall`
- `macro_recall@all`
- `micro_recall@all`

Interpretation:

- how much relevant evidence did the agent surface anywhere in the final accumulated retrieved set?

### Prefix-of-agent-set metrics

These use the first `k` documents of the same final sequence:

- `recall@100`
- `recall@1000`
- `ndcg@10`
- `mrr@10`
- `map`

Interpretation:

- how good is the first-k prefix of the final accumulated retrieval sequence?

## What `merged/` means

For sharded runs, each shard executes a disjoint subset of queries and writes its own per-query artifacts.
The merge step copies those per-query artifacts into one canonical directory:

- `runs/<run>/merged/`

This is a file-level merge only.
It is not score fusion, rank fusion, or any cross-shard ranking merge.
Each query is still evaluated from its own per-query accumulated doc sequence.

## Retrieval-evaluation backends

Benchmark manifests can choose different retrieval backends:

- internal TypeScript evaluation for run-dir agent-set semantics
- `trec_eval` for standard IR run-file benchmarks

This separation matters because a standard benchmark like MSMARCO TREC DL should use benchmark-correct run-file semantics, while a run directory of agent JSON artifacts should still use accumulated-doc agent-set semantics.

## Benchmark-specific retrieval semantics

Retrieval semantics are benchmark-driven, not hardcoded by benchmark name in random call sites.

Examples of configurable semantics include:

- nDCG gain mode
- recall relevance threshold
- binary relevance threshold for MAP/MRR

For example, MSMARCO TREC DL semantics in this repo use:

- linear nDCG gain
- recall relevance threshold `qrel >= 2`
- binary relevance threshold `qrel >= 1` for MAP/MRR

That alignment exists so both evaluation and report-side coverage interpretation remain benchmark-correct.

## Normalized retrieval summary artifacts

Both retrieval backends now write machine-readable normalized summaries under:

- `evals/retrieval/<benchmark>/<source-relative-path>.summary.json`

These normalized artifacts let downstream tools consume authoritative aggregate metrics without re-deriving them from unrelated assumptions.

Reports and BM25 comparisons prefer matching normalized summaries when present, while raw recomputation remains available for fallback and detailed per-query diagnostics.

## Judge evaluation modes

Judge evaluation supports two explicit modes:

- `gold-answer`
- `reference-free`

The benchmark manifest declares which modes are supported and which mode is the benchmark default.

### Gold-answer mode

The judge sees:

- the question
- the run's final answer
- a benchmark gold answer

Interpretation:

- this is externally anchored gold-answer correctness

Human-facing reports label the top-line metric as:

- `Accuracy (gold-answer judge)`

### Reference-free mode

The judge sees:

- the question
- the run's final answer
- no benchmark gold answer

Interpretation:

- this is judge-estimated correctness, not benchmark gold-answer accuracy

Human-facing reports label the top-line metric as:

- `Accuracy (reference-free judge)`

The top-line metric name remains `accuracy` for interpretability, but the mode and semantics must always be explicit.

## Benchmark defaults for judge mode

Current benchmark defaults:

- `browsecomp-plus` — `gold-answer`
- `msmarco-v1-passage` — `reference-free`
- `benchmark-template` — `gold-answer`

MSMARCO defaults to reference-free judge evaluation because the benchmark is retrieval-first in this repo and should not fake BrowseComp-style answer supervision.

## Judge outputs and summaries

Judge outputs are written under a benchmark-aware layout by default:

- `evals/pi_judge/<benchmark>/<run-relative-path>/...`

Historical flat legacy paths are still autodetected for compatibility.

Judge evaluation summaries now include explicit semantic fields such as:

- `Judge Mode`
- `Accuracy Label`
- `Accuracy Semantics`

That makes the mode visible to both humans and downstream machine consumers.

## Report semantics

Reports combine:

- retrieval metrics
- judge metrics when available
- run setup metadata
- run provenance and report provenance

Important report behavior:

- coverage and hit-depth sections use benchmark-aware recall relevance thresholds
- aggregate retrieval sections prefer normalized retrieval summaries when a matching artifact exists
- reports show `Run commit` from stored run artifacts when available
- reports show `Report commit` from the checkout used to generate the report
- reports prefer structured `run_setup.json` for reproducibility metadata and use legacy `logs/run.log` only as fallback

## Why the split between retrieval and judge matters

A run can be strong on retrieval and weak on answer generation, or the reverse.
That is why the repo keeps:

- retrieval metrics benchmark-aware and qrels-anchored
- judge metrics mode-aware and explicitly labeled

The correct reading is:

- retrieval metrics tell you what evidence the run surfaced
- judge metrics tell you how correct the final answer appears under the selected judge mode
