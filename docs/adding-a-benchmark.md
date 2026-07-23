# Adding a benchmark

This repo is benchmark-manifest-driven. Most datasets should be added as dynamically installed
JSON manifests, without changing the TypeScript registry. Add a built-in typed definition only
when the benchmark is a permanent package feature with code-owned setup, managed presets, or
semantics that cannot be expressed declaratively.

Related docs:

- [running-benchmarks.md](./running-benchmarks.md) for the operator surface you should preserve
- [evaluation.md](./evaluation.md) for retrieval and judge semantics you must model explicitly
- [reproducibility.md](./reproducibility.md) for run-manifest snapshots, setup artifacts, and provenance expectations

## Design intent

The architecture intentionally separates:

- generic orchestration concerns under `src/orchestration/`
  - setup dispatch
  - benchmark/query-set default resolution
  - run-manifest snapshots
  - summarize/eval/report entrypoints
  - managed preset lookup
- compatibility-only preserved historical contracts under `src/legacy/`
  - low-level entrypoints retained for wrapper and workflow compatibility
- shared runtime primitives under `src/runtime/`
  - prompt construction
  - artifact-path helpers
  - isolated agent-dir handling
- reusable benchmark metadata in installed `benchmark.json` files
  - dataset/query files
  - qrels and optional secondary qrels
  - optional ground truth
  - evaluation modes and index paths
- package-owned benchmark concerns under `src/benchmarks/` plus benchmark-scoped setup scripts
  - dataset/query files
  - qrels and optional secondary qrels
  - optional ground truth
  - setup scripts
  - optional managed presets

That separation is what keeps multi-benchmark support maintainable.

## 1. Choose installed or built-in integration

Use an installed manifest when the benchmark only needs:

- ids, aliases, and display metadata
- query-set paths
- qrels and optional ground-truth paths
- an index path or remote index name
- existing retrieval and judge evaluation modes

Install it with:

```bash
npm run install:benchmark-manifest -- \
  --manifest path/to/benchmark.json \
  --dry-run

npm run install:benchmark-manifest -- \
  --manifest path/to/benchmark.json
```

The default destination is `data/prebuilt/<benchmark-id>/benchmark.json`. Installed manifests are
automatically visible to launch, evaluation, reporting, and benchmark discovery. Installation is
idempotent for identical content and protects differing existing content unless `--force` is
explicit.

Use a built-in TypeScript definition only when the package must ship benchmark-specific code,
setup steps, managed presets, or genuinely distinct evaluation semantics.

## 2. Define benchmark metadata

For an installed benchmark, create a JSON object matching `BenchmarkDefinition`. For a built-in
benchmark, create a TypeScript file under:

- `src/benchmarks/<your_benchmark>.ts`

Export a `BenchmarkDefinition`.
The current examples are:

- `src/benchmarks/browsecomp_plus.ts`
- `src/benchmarks/template_benchmark.ts` for a tiny self-contained local benchmark that builds its own demo index

A benchmark definition must specify:

- `id`
- `aliases`
- `displayName`
- `datasetId`
- `piSearchPromptVariant`
- `defaultQuerySetId`
- `defaultQueryPath`
- `querySets`
- `defaultQrelsPath`
- `defaultSecondaryQrelsPath` if applicable
- `defaultGroundTruthPath` if applicable
- `defaultIndexPath`
- `managedPresets`
- `setup.steps`

Important rule:
keep defaults benchmark-scoped and declarative here instead of spreading them across CLI entrypoints.

`querySets` can be either:

- a simple string query path
- or an object with query-set-specific overrides such as `queryPath`, `qrelsPath`, `secondaryQrelsPath`, `groundTruthPath`, and `indexPath`

Use query-set-specific overrides when different query sets need different qrels, as with MSMARCO `dl19` vs `dl20`.

## 3. Register built-in benchmarks only

Update:

- `src/benchmarks/registry.ts`

Import the new benchmark and add it to `BUILTIN_BENCHMARKS`.

Skip this step for installed manifests. Once a built-in definition is registered, these generic
helpers will automatically understand it:

- `getBenchmarkDefinition()`
- `resolveBenchmarkConfig()`
- `createBenchmarkManifestSnapshot()`
- `resolveManagedPreset()`
- `resolveBenchmarkSetupStep()`

## 4. Add benchmark-scoped setup scripts when necessary

Add benchmark-specific setup implementations under:

- `scripts/benchmarks/<your_benchmark>/setup.sh`
- `scripts/benchmarks/<your_benchmark>/setup_ground_truth.sh` if needed
- `scripts/benchmarks/<your_benchmark>/generate_query_slices.sh` if needed

Then point `setup.steps` at those scripts from the benchmark definition.

Those benchmark scripts should be checked in as directly executable files (`chmod +x ...`). The active TypeScript control plane now launches them directly rather than wrapping them in `bash`, so executable mode is part of the contract.

Why this boundary exists:
setup internals are often dataset-specific, but setup dispatch should still be standardized.

The current architectural decision is to keep benchmark setup implementations as benchmark-scoped subprocess boundaries unless a benchmark's setup becomes simple enough to be genuinely generic. In other words, `src/orchestration/setup_benchmark_entry.ts` owns the operator-facing control plane, while `scripts/benchmarks/<your_benchmark>/...` owns the benchmark-specific bootstrap details.

## 5. Decide evaluation semantics

The generic retrieval/report pipeline assumes path defaults can come from the benchmark manifest, but not every benchmark necessarily has the same semantics.

Decide explicitly:

- Is retrieval evaluation supported?
- Is there a secondary qrels view?
- Is judge evaluation supported?
- Does ground truth exist in a compatible format?
- Do report sections still make sense for this benchmark?

A valid answer is "retrieval-only for now". If a benchmark does not naturally provide answer-style ground truth, you now have two explicit judge options:

- `gold-answer` mode: set `defaultGroundTruthPath` and treat reported accuracy as externally anchored gold-answer accuracy
- `reference-free` mode: leave `defaultGroundTruthPath` unset, declare reference-free judge support in the benchmark manifest, and make sure reports label the top-line metric as `Accuracy (reference-free judge)` rather than implying gold-answer supervision

Do not invent fake ground-truth compatibility just to reuse the gold-answer path.

If the benchmark requires semantic differences instead of just different paths, add benchmark-specific evaluation adapters deliberately rather than smuggling differences through ad hoc conditionals. The current mechanism is `BenchmarkDefinition.retrievalEvaluation`, which lets a benchmark choose an internal TypeScript backend or a `trec_eval` run-file backend. Both backends now write normalized retrieval-summary artifacts under `evals/retrieval/<benchmark>/...`.

## 6. Decide managed presets

If the benchmark needs operator-facing managed presets for `benchctl`, define them in:

- `managedPresets`

Each preset can define:

- launcher script
- output-dir template
- log-dir template
- launcher env
- default shard count

Use registry-defined presets for benchmark-specific ergonomics, but keep generic launch entrypoints benchmark-agnostic.

## 7. Add or stage local assets

Typical local asset layout should remain benchmark-scoped:

- `data/<dataset>/queries/...`
- `data/<dataset>/qrels/...`
- `data/<dataset>/ground-truth/...`
- `indexes/<index-name>/`

Avoid reusing BrowseComp-Plus paths or names in a new benchmark unless the assets are genuinely shared.

## 8. Verify run-manifest behavior

Every run should emit:

- `<run>/benchmark_manifest_snapshot.json`

New direct runs should also emit:

- `<run>/run_setup.json`

Verify that downstream tools resolve your benchmark correctly from those artifacts:

- summarize
- retrieval eval
- judge eval if supported
- Markdown report
- monitor autodetection

This is critical because reproducibility now depends on artifact-local benchmark metadata, not only mutable repo defaults.

## 9. Add tests

For an installed manifest, test validation, installation, discovery, and launcher dry-run
resolution. For a built-in benchmark, add or update tests for:

- registry lookup
- query-set resolution
- setup-step resolution
- managed preset lookup if applicable
- launcher dry-run/default resolution
- report/eval/summarize manifest precedence if your benchmark changes those paths

Good starting files:

- `tests/installed_benchmark_manifest.test.ts`
- `tests/benchmarks/registry.test.ts`
- `tests/launcher_wrappers.test.ts`
- `tests/report_run_markdown.test.ts`

## 10. Document the benchmark

Update operator-facing docs:

- `README.md`
- `docs/running-benchmarks.md`
- `docs/evaluation.md` if the benchmark changes semantics
- `docs/reproducibility.md` if the benchmark changes setup or provenance expectations
- this file if the benchmark introduces new conventions worth standardizing

Document:

- benchmark id
- supported query sets
- setup path
- expected local assets
- whether judge evaluation is supported
- any managed presets

## Practical checklist

Use this as the short version:

1. Prefer a JSON `BenchmarkDefinition` and install it with `install:benchmark-manifest`
2. Add local dataset/index path conventions under `data/` and `indexes/`
3. Verify benchmark discovery and launcher dry-run output
4. Verify run-manifest snapshot and `run_setup.json` output
5. Verify summarize/eval/report behavior
6. Add a built-in TypeScript definition only if package-owned behavior requires it
7. Add tests and update docs

## What not to do

Do not:

- hardcode new benchmark defaults into many separate CLIs
- add a built-in registry entry for a path-only dataset that an installed manifest can express
- add fallback legacy dual-mode logic unless there is a real compatibility requirement
- hide benchmark-specific evaluation semantics inside generic path helpers
- make shell wrappers the only supported path for a new benchmark

The intended steady state is:

- reusable benchmark metadata lives in validated installed manifests
- package-owned benchmark metadata lives in typed registry entries
- active Node-first entrypoints live under `src/orchestration/`
- compatibility-only TypeScript entrypoints live under `src/legacy/`
- shared runtime helpers live under `src/runtime/`
- benchmark setup scripts remain benchmark-scoped subprocess implementations unless they become genuinely generic enough to migrate cleanly
- the BM25 JVM helper remains callable through `scripts/bm25_server.sh`, but Anserini-provider launch semantics are owned in typed TypeScript under `src/search-providers/anserini/`
- shell is a compatibility or subprocess boundary, not the control plane
