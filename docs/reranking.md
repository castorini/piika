# Reranking search results with rank_llm

Reranking is opt-in. Without the flags below (or `PI_SEARCH_RERANK_CONFIG`), the search tool,
the prompts, and the run artifacts are exactly what they are without this feature.

With it, each call of the direct `search` tool (`--tool-interface pyserini-rest-2tool`) asks
the first stage for a deeper pool (`--rerank-depth`, default 100), sends the pool to a rank_llm
worker, and shows the agent the worker's top `k` instead of the first-stage top `k`. The agent's
`hits` argument still sets `k`. Ranking logic lives in [rank_llm](https://github.com/castorini/rank_llm);
piika only forwards the query, the candidates, and the context it is allowed to send.

## 1. Start a worker

`scripts/rank_llm_rerank_worker.py` imports rank_llm as a library and serves `POST /rerank` and
`GET /healthz`. The model itself is served by vLLM. Every rank_llm setting is a flag; see
`python scripts/rank_llm_rerank_worker.py --help`.

```bash
# vLLM serving the reranker, e.g.
vllm serve Qwen/Qwen3-Reranker-4B --port 8000 --max-model-len 8192 \
  --enable-prefix-caching --logprobs-mode processed_logprobs

# pointwise yes/no relevance (one forward pass per candidate), scored as on the
# Qwen3-Reranker model card: P(yes) over P(yes) + P(no)
python scripts/rank_llm_rerank_worker.py --port 8200 --kind pointwise \
  --model Qwen/Qwen3-Reranker-4B --vllm-url http://127.0.0.1:8000/v1 \
  --positive-token yes --negative-token no

# setwise selection over sliding windows (a generative listwise model)
python scripts/rank_llm_rerank_worker.py --port 8201 --kind setwise \
  --model <model> --vllm-url http://127.0.0.1:8001/v1 \
  --template <prompt_template.yaml> --window-size 20 --stride 10
```

`--logprobs-mode processed_logprobs` matters for pointwise scoring: with vLLM's default
`raw_logprobs`, tokens restricted by `allowed_token_ids` can be missing from `top_logprobs`.

Worker flags that shape what the model sees:

| Flag                                                           | Meaning                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--kind pointwise\|setwise`                                    | rank_llm pointwise vLLM coordinator, or the listwise one with sliding windows                                                                                                                                                        |
| `--template`, `--template-<mode>`                              | prompt template per context mode (`global-query`, `reasoning`, `full`); the mode is chosen per request from the fields actually sent                                                                                                 |
| `--field-map SRC=DST`                                          | rename a context field for the template, e.g. `reasoning=query_intent`                                                                                                                                                               |
| `--field-max-tokens FIELD=N`                                   | cap a field at N tokens of the served model's tokenizer, head kept (`query` caps the search query)                                                                                                                                   |
| `--context-size`, `--batch-size`                               | rank_llm context window and batch size                                                                                                                                                                                               |
| `--max-passage-words`, `--max-passage-tokens`                  | passage caps                                                                                                                                                                                                                         |
| `--window-size`, `--stride`                                    | setwise windows                                                                                                                                                                                                                      |
| `--temperature`, `--top-p`, `--top-k`, `--min-p`, `--thinking` | setwise sampling                                                                                                                                                                                                                     |
| `--positive-token`, `--negative-token`                         | pointwise answer tokens, repeatable (e.g. `yes` / `no`, or `true` / `false`); the score is the probability of a positive token over that of any answer token. Unset: the template's `output_tokens`, else rank_llm's yes/no defaults |
| `--log-requests FILE`, `--log-prompts none\|first\|all`        | one JSONL line per request: candidates, scores or windows, returned docids, prompts                                                                                                                                                  |

Context modes other than `none` need a rank_llm build whose `Query` carries named context
fields (`Query.fields`) and templates that render them. `--positive-token` / `--negative-token`
need a rank_llm whose `PointwiseVLLM` takes `positive_tokens` / `negative_tokens`.

## 2. Run piika against it

```bash
npm run run:benchmark:query-set -- --benchmark <id> --query-set <set> \
  --tool-interface pyserini-rest-2tool \
  --rerank-worker-url http://127.0.0.1:8200 --rerank-context-mode full --rerank-depth 100
```

`src/orchestration/run_pi_benchmark.ts` takes the same flags (camelCase also works, e.g.
`--rerankWorkerUrl`).

| Flag                                | Default              | Meaning                                                                          |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `--rerank-worker-url <url>`         | unset = no reranking | the worker; setting it turns reranking on                                        |
| `--rerank-context-mode <mode>`      | `none`               | most context the worker may receive: `none`, `global_query`, `reasoning`, `full` |
| `--rerank-depth <n>`                | 100                  | first-stage candidates handed to the worker                                      |
| `--rerank-max-trace-chars <n>`      | 2048                 | characters of reasoning trace forwarded, head kept, cut on a word boundary       |
| `--rerank-timeout-ms <ms>`          | 300000               | per-attempt timeout                                                              |
| `--rerank-retry-attempts <n>`       | 4                    | attempts before the search call fails                                            |
| `--rerank-retry-base-delay-ms <ms>` | 1000                 | first retry delay, doubled per retry, with jitter                                |

The shared and sharded launchers do not take these flags; set `PI_SEARCH_RERANK_CONFIG` to the
same settings as JSON instead (`{"workerUrl": "...", "contextMode": "full", "depth": 100}`).
Flags and the variable are alternatives; setting both is an error.

## Context

- `global_query`: the benchmark question that opened the session.
- `reasoning`: the thinking blocks of the assistant message that issued this search call,
  captured when pi fires `tool_call` (the one moment the query and its reasoning are both known).
- `full`: both.

A field is sent only when the run allows it and the agent produced it; the worker picks the
template for the fields it actually received, so a prompt never announces an empty field.

## Failures and records

A failed worker call is retried with exponential backoff. If it still fails, or the worker's
ranking does not fill the `k` visible slots, the search call fails with a `PiSearchRerankError`;
it never falls back to first-stage order.

Each reranked search records `details.firstStageK` and `details.rerank` (`applied`, `depth`,
`contextFields`, `elapsedMs`, and the worker's token `usage`) in the tool result, and
`run_setup.json` records the rerank config.
