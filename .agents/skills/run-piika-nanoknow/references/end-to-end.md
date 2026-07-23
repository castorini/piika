# NanoKnow end-to-end workflows

## 1. Select NQ or SQuAD

Set these values consistently.

NQ-Open:

```bash
NANOKNOW_BENCHMARK=nanoknow-nq
NANOKNOW_DATA_DIR=data/nanoknow-nq
NANOKNOW_MANIFEST=.agents/skills/run-piika-nanoknow/assets/nanoknow-nq.benchmark.json
```

SQuAD:

```bash
NANOKNOW_BENCHMARK=nanoknow-squad
NANOKNOW_DATA_DIR=data/nanoknow-squad
NANOKNOW_MANIFEST=.agents/skills/run-piika-nanoknow/assets/nanoknow-squad.benchmark.json
```

The commands below assume the selected values remain in the current shell.

## 2. Verify and prepare assets

Required files:

```bash
test -f "$NANOKNOW_DATA_DIR/queries/climbmix-supported.tsv"
test -f "$NANOKNOW_DATA_DIR/qrels/climbmix-supported.txt"
test -f "$NANOKNOW_DATA_DIR/source/answers.jsonl"
```

Prepare judge-compatible multi-answer ground truth:

```bash
npm run adapt:multi-answer-ground-truth -- \
  --queries "$NANOKNOW_DATA_DIR/queries/climbmix-supported.tsv" \
  --answers "$NANOKNOW_DATA_DIR/source/answers.jsonl" \
  --output "$NANOKNOW_DATA_DIR/ground-truth/climbmix-supported.jsonl" \
  --id-field qid \
  --answers-field answer
```

Install the dataset manifest:

```bash
npm run install:benchmark-manifest -- \
  --manifest "$NANOKNOW_MANIFEST" \
  --dry-run

npm run install:benchmark-manifest -- \
  --manifest "$NANOKNOW_MANIFEST"
```

Confirm discovery:

```bash
npm run run:benchmark:query-set -- --help
```

The selected benchmark must appear with query set `climbmix-supported`.

## 3. Configure the ClimbMix backend

Use the Pyserini REST service that exposes `climbmix-400b`:

```bash
export PYSERINI_REST_BASE_URL=http://127.0.0.1:8080
export PYSERINI_REST_INDEX=climbmix-400b
```

If the service requires a bearer token:

```bash
export PYSERINI_API_TOKEN=<token>
export PYSERINI_REST_TOKEN_ENV=PYSERINI_API_TOKEN
```

Do not put the token in a benchmark manifest or committed command file. Confirm service reachability before running thousands of queries.

## 4A. Retrieval-only condition

Choose an output directory:

```bash
NANOKNOW_RUN_DIR="runs/${NANOKNOW_BENCHMARK}-retrieval"
```

Inspect the plan:

```bash
npm run run:benchmark:query-set -- \
  --dry-run \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --query-set climbmix-supported \
  --output-dir "$NANOKNOW_RUN_DIR" \
  --output-mode answer \
  --tool-interface pyserini-rest-2tool
```

Run a smoke test:

```bash
npx tsx src/orchestration/run_pi_benchmark.ts \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --querySet climbmix-supported \
  --outputDir "$NANOKNOW_RUN_DIR-smoke" \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --limit 3 \
  --toolInterface pyserini-rest-2tool
```

Run the complete query set:

```bash
npm run run:benchmark:query-set -- \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --query-set climbmix-supported \
  --output-dir "$NANOKNOW_RUN_DIR" \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --timeout-seconds 900 \
  --output-mode answer \
  --tool-interface pyserini-rest-2tool
```

## 4B. Supplied-document condition

Set the supplied bundle path and a distinct output directory:

```bash
NANOKNOW_SUPPLIED_DOC_BUNDLE=/absolute/path/to/supplied-docs.jsonl
NANOKNOW_RUN_DIR="runs/${NANOKNOW_BENCHMARK}-supplied-docs"
test -f "$NANOKNOW_SUPPLIED_DOC_BUNDLE"
```

Each JSONL row must have this shape:

```json
{
  "qid": "query-id",
  "question": "Question text",
  "groups": [
    {
      "docs": [
        {
          "doc_id": "document-id",
          "cited_snippet": "The source-provided supporting excerpt",
          "full_text": "The complete supplied document text"
        }
      ]
    }
  ]
}
```

Requirements:

- Include exactly the intended experimental query population.
- Use qids matching NanoKnow qrels and ground truth.
- Preserve document groups and stable document ids.
- Do not include gold answers as document fields or prompt text.
- Treat empty `cited_snippet` or `full_text` as data-quality issues even though the runner has fallbacks.

Inspect the plan:

```bash
npm run run:benchmark:query-set -- \
  --dry-run \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --query-set climbmix-supported \
  --supplied-doc-bundle "$NANOKNOW_SUPPLIED_DOC_BUNDLE" \
  --output-dir "$NANOKNOW_RUN_DIR" \
  --output-mode answer \
  --tool-interface pyserini-rest-2tool
```

Run a three-query smoke test through the low-level runner:

```bash
npx tsx src/orchestration/run_pi_benchmark.ts \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --querySet climbmix-supported \
  --supplied-doc-bundle "$NANOKNOW_SUPPLIED_DOC_BUNDLE" \
  --outputDir "$NANOKNOW_RUN_DIR-smoke" \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --limit 3 \
  --toolInterface pyserini-rest-2tool
```

Run the complete supplied-document population:

```bash
npm run run:benchmark:query-set -- \
  --benchmark "$NANOKNOW_BENCHMARK" \
  --query-set climbmix-supported \
  --supplied-doc-bundle "$NANOKNOW_SUPPLIED_DOC_BUNDLE" \
  --output-dir "$NANOKNOW_RUN_DIR" \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --timeout-seconds 900 \
  --output-mode answer \
  --tool-interface pyserini-rest-2tool
```

Supplied docids should appear in each run's metadata and surfaced, previewed, and agent-visible docid views.

## 5. Evaluate and report either condition

Retrieval evaluation:

```bash
RUN_DIR="$NANOKNOW_RUN_DIR" npm run evaluate:retrieval
```

Gold-answer judge:

```bash
INPUT_DIR="$NANOKNOW_RUN_DIR" npm run evaluate:run -- \
  --judge-mode gold-answer
```

Summary and report:

```bash
RUN_DIR="$NANOKNOW_RUN_DIR" npm run summarize:run
RUN_DIR="$NANOKNOW_RUN_DIR" npm run report:run
```

## 6. Comparison checks

Before comparing the two conditions, confirm:

```bash
test -f "$NANOKNOW_RUN_DIR/benchmark_manifest_snapshot.json"
test -f "$NANOKNOW_RUN_DIR/run_setup.json"
```

Inspect these fields:

- benchmark and query-set ids;
- model and thinking level;
- tool interface and backend kind;
- timeout and total query count;
- supplied bundle path for the supplied condition;
- failed, timed-out, and completed query counts;
- input hashes in the benchmark snapshot.

Do not compare aggregate accuracy or retrieval metrics until both conditions contain the intended identical qid population.
