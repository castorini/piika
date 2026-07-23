# Piika workflow reference

## Entry points

```bash
npm run run:benchmark:query-set -- --help
npm run run:benchmark:query-set:shared-bm25 -- --help
npm run run:benchmark:query-set:sharded-shared-bm25 -- --help
npm run evaluate:retrieval -- --help
npm run evaluate:run -- --help
npm run summarize:run -- --help
npm run report:run -- --help
```

The packaged CLI exposes the same orchestration:

```bash
npx piika --help
npx piika benchmarks
```

## Dependency and quality checks

```bash
npm install
npm run typecheck
npm test
npm run check
```

Do not reinstall dependencies when `node_modules` is already usable unless the lockfile changed or a command reports a missing dependency.

## Benchmark setup choices

Built-in setup:

```bash
npm run setup:benchmark -- --benchmark benchmark-template
npm run setup:benchmark -- --benchmark msmarco-v1-passage
```

Castorini prebuilt setup:

```bash
npm run prebuilt -- indexes
npm run prebuilt -- topics <search>
npm run prebuilt -- qrels <search>
npm run prebuilt -- setup <index-id> --topics <topics-id> --qrels <qrels-id> --dry-run
npm run prebuilt -- setup <index-id> --topics <topics-id> --qrels <qrels-id>
```

Custom installed manifest:

```bash
npm run install:benchmark-manifest -- \
  --manifest path/to/benchmark.json \
  --dry-run

npm run install:benchmark-manifest -- \
  --manifest path/to/benchmark.json
```

The default destination is `data/prebuilt/<benchmark-id>/benchmark.json`. Set `PIIKA_BENCHMARKS_DIR` or pass `--root` to use another installed-manifest root. Installation is idempotent for identical manifests and refuses differing replacements unless `--force` is explicit.

Required manifest shape:

```json
{
  "id": "custom-benchmark",
  "aliases": [],
  "displayName": "Custom Benchmark",
  "datasetId": "custom-benchmark",
  "piSearchPromptVariant": "plain_minimal",
  "defaultQuerySetId": "test",
  "defaultQueryPath": "data/custom/queries.tsv",
  "querySets": {
    "test": "data/custom/queries.tsv"
  },
  "defaultQrelsPath": "data/custom/qrels.txt",
  "defaultGroundTruthPath": "data/custom/ground-truth.jsonl",
  "defaultIndexPath": "indexes/custom",
  "managedPresets": {},
  "setup": { "steps": {} },
  "retrievalEvaluation": {
    "runFileBackend": "internal",
    "runDirBackend": "internal"
  },
  "judgeEvaluation": {
    "supportedModes": ["gold-answer", "reference-free"],
    "defaultMode": "gold-answer"
  }
}
```

## Backends

Remote Pyserini REST:

```bash
PYSERINI_REST_BASE_URL=http://host:port \
PYSERINI_REST_INDEX=<index-name> \
npm run run:benchmark:query-set -- \
  --benchmark <benchmark-id> \
  --tool-interface pyserini-rest-2tool
```

If authentication is required, set the token variable and `PYSERINI_REST_TOKEN_ENV` according to the service configuration. Do not write tokens into manifests, commands committed to source, or run metadata.

Local single-process BM25:

```bash
npm run run:benchmark:query-set -- \
  --benchmark <benchmark-id> \
  --index-path indexes/<index>
```

Shared local BM25:

```bash
npm run run:benchmark:query-set:shared-bm25 -- \
  --benchmark <benchmark-id>
```

Sharded shared local BM25:

```bash
npm run run:benchmark:query-set:sharded-shared-bm25 -- \
  --benchmark <benchmark-id> \
  --shard-count 4
```

## Output modes

Answer:

```bash
--output-mode answer
```

Ranked list:

```bash
--output-mode ranked_list --ranked-list-depth 1000
```

Answer and ranking:

```bash
--output-mode answer+ranked_list --ranked-list-depth 30
```

Exact count:

```bash
--ranked-list-depth 30 --ranked-list-count 30
```

## Supplied documents

Pass a JSONL file:

```bash
--supplied-doc-bundle path/to/supplied-docs.jsonl
```

Each row must contain:

```json
{
  "qid": "q1",
  "question": "Question text",
  "groups": [
    {
      "docs": [
        {
          "doc_id": "d1",
          "cited_snippet": "Relevant excerpt",
          "full_text": "Full document text"
        }
      ]
    }
  ]
}
```

Supplied docids are recorded in metadata and count as surfaced, previewed, and agent-visible evidence. The agent may still use the configured search backend for gaps.

## Evaluation and reporting

Retrieval evaluation:

```bash
RUN_DIR=runs/<run> npm run evaluate:retrieval
```

Gold-answer judge:

```bash
INPUT_DIR=runs/<run> npm run evaluate:run -- \
  --judge-mode gold-answer
```

Explicit gold and qrels overrides:

```bash
INPUT_DIR=runs/<run> npm run evaluate:run -- \
  --judge-mode gold-answer \
  --ground-truth path/to/ground-truth.jsonl \
  --qrel-evidence path/to/qrels.txt
```

Reference-free judge:

```bash
INPUT_DIR=runs/<run> npm run evaluate:run -- \
  --judge-mode reference-free
```

Summarize and report:

```bash
RUN_DIR=runs/<run> npm run summarize:run
RUN_DIR=runs/<run> npm run report:run
```

## Multi-answer ground truth

Convert a source JSONL containing an id and an array of acceptable answers:

```bash
npm run adapt:multi-answer-ground-truth -- \
  --queries path/to/queries.tsv \
  --answers path/to/source-answers.jsonl \
  --output path/to/ground-truth.jsonl \
  --id-field qid \
  --answers-field answer
```

The output stores the acceptable alternatives in the judge-compatible ground-truth format. The judge treats a match to any alternative as correct.
