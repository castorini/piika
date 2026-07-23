# MS MARCO v1 Passage ranked-list results

This note tracks agent-generated ranked-list runs against the three query sets in the
[Pyserini MS MARCO v1 Passage reproduction matrix](https://castorini.github.io/pyserini/2cr/msmarco-v1-passage.html).

## Comparison protocol

The reproduction matrix reports these official metrics:

| Query set            |           Topics | Metrics                             |
| -------------------- | ---------------: | ----------------------------------- |
| TREC DL 2019         | 43 judged topics | AP (`-l 2`), nDCG@10, R@1K (`-l 2`) |
| TREC DL 2020         | 54 judged topics | AP (`-l 2`), nDCG@10, R@1K (`-l 2`) |
| MS MARCO passage dev |     6,980 topics | RR@10, R@1K                         |

Agent runs use `openai-codex/gpt-5.5`, thinking level `medium`, the Pyserini REST
`msmarco-v1-passage` index, and the `pyserini-rest-2tool` interface. The two exposed
tools are `search` and `read_document`. Search returns ranked hits directly; the model
chooses a hit count from 1 to 100 for each call.

Pyserini reference runs retrieve 1,000 documents per query. The current agent-only
condition ranks only unique docids explicitly selected in the model's final response.
Therefore AP, nDCG@10, and RR@10 are useful ranking comparisons, while R@1K is reported
but is not depth-matched and must not be presented as a fair recall comparison. A future
depth-1,000 condition should be labeled separately, for example by reranking a fixed
1,000-document candidate set or by using a documented deterministic tail policy.

For TREC DL, judged-only topic files are used to avoid model calls for unjudged topics.
This is score-equivalent under the official qrels because `trec_eval` averages over the
judged qids. The full topic files remain the benchmark defaults.

## GPT-5.5 results

| Query set | Status                |     AP | nDCG@10 |  RR@10 |   R@1K | Final depth                           |
| --------- | --------------------- | -----: | ------: | -----: | -----: | ------------------------------------- |
| DL20      | 54/54 completed       | 0.4492 |  0.7412 |    n/a | 0.5376 | min 3, median 20, mean 23.35, max 70  |
| DL19      | 43/43 completed       | 0.3780 |  0.7381 |    n/a | 0.4811 | min 3, median 25, mean 27.47, max 60  |
| dev       | 6,980/6,980 completed |    n/a |     n/a | 0.3300 | 0.6725 | min 0, median 24, mean 26.34, max 149 |

DL20 run details:

- Run: `runs/msmarco-v1-passage-dl20-judged-ranked-gpt55-pyserini-rest-2tool`
- Merged run file: `merged/ranked_list.trec`
- 316 search calls requested 6,535 hits total (mean 20.68 per call; range 10-50).
- The merged run contains 1,261 unique ranked lines across 54 queries.

DL19 run details:

- Run: `runs/msmarco-v1-passage-dl19-judged-ranked-gpt55-pyserini-rest-2tool`
- Merged run file: `merged/ranked_list.trec`
- The merged run contains 1,181 unique ranked lines across 43 queries.

Dev run details:

- Run: `runs/msmarco-v1-passage-dev-ranked-gpt55-pyserini-rest-2tool-sharded8`
- Eight shards processed all 6,980 topics with the same model, thinking level, REST index,
  tool interface, and prompt as DL19/DL20.
- The merged run contains 183,847 ranked lines across 6,947 nonempty rankings; 33
  queries produced no parseable ranked list and score as misses.
- A 16-shard launch was rejected after two shards failed initial credential resolution;
  eight shards passed a 100-query stability checkpoint with no failures.

## Reference points

The Pyserini matrix reports the following representative depth-1,000 results:

| System                  | DL19 AP | DL19 nDCG@10 | DL19 R@1K | DL20 AP | DL20 nDCG@10 | DL20 R@1K | dev RR@10 | dev R@1K |
| ----------------------- | ------: | -----------: | --------: | ------: | -----------: | --------: | --------: | -------: |
| BM25, k1=0.9, b=0.4     |  0.3013 |       0.5058 |    0.7501 |  0.2856 |       0.4796 |    0.7863 |    0.1840 |   0.8526 |
| SPLADE++ EnsembleDistil |  0.5050 |       0.7308 |    0.8728 |  0.4999 |       0.7197 |    0.8998 |    0.3828 |   0.9831 |

Reference values are snapshots from the linked Pyserini reproduction page and should be
rechecked when updating this note.

The locally generated depth-1,000 BM25 runs reproduce all eight BM25 values in the table
exactly. Their summaries are under `evals/retrieval/msmarco-v1-passage/data/`.

## Exact-count ablation on DL19

### Motivation

`RANKED_LIST_DEPTH` and `RANKED_LIST_COUNT` have deliberately different semantics:

- `RANKED_LIST_DEPTH` is a maximum output depth. When count is omitted, the agent decides how
  many unique documents it has enough evidence to rank.
- `RANKED_LIST_COUNT` is an exact requirement. It changes the prompt, validates the returned
  length, truncates overlong output, and records an error for short output.

The exact-count option was introduced while answer and ranked-list outputs were being made
atomic and composable. DL19 was used to test whether requiring exactly 10 documents was only a
serialization constraint or whether it also changed the agent's retrieval policy. It changed the
retrieval policy substantially.

### Controlled conditions

All corrected-prompt ablations used the same conditions except for output mode and exact count:

- 43 judged TREC DL 2019 passage topics;
- `openai-codex/gpt-5.5`, thinking level `medium`;
- prompt variant `plain_minimal`;
- four shards and a 900-second per-query timeout;
- Pyserini REST index `msmarco-v1-passage`;
- the direct `pyserini-rest-2tool` interface (`search` and `read_document`);
- BM25 defaults k1=0.9 and b=0.4;
- `trec_eval -c -l 2 -m map`, `trec_eval -c -m ndcg_cut.10`, and
  `trec_eval -c -l 2 -m recall.1000`.

The optional-count run set `RANKED_LIST_DEPTH=1000` and omitted `RANKED_LIST_COUNT`. The
exact-10 runs set both depth and count to 10. Because the agent produces only the documents it
selects, `recall.1000` means recall at the available run depth; it is not depth-matched across
these conditions.

### Results

| Prompt / output condition                     | Exact count |         AP |    nDCG@10 |       R@1K | Returned depth                                        |
| --------------------------------------------- | ----------: | ---------: | ---------: | ---------: | ----------------------------------------------------- |
| Historical ranked-list-only                   |     omitted |     0.3780 |     0.7381 |     0.4811 | min 3, median 25, mean 27.47, max 60; 1,181 total     |
| Pre-fix ranked-list-only                      |          10 |     0.2280 |     0.7148 |     0.2768 | exactly 10; 430 total                                 |
| Pre-fix answer + ranked list                  |          10 |     0.2289 |     0.6910 |     0.2636 | exactly 10; 430 total                                 |
| Corrected ranked-list-only                    |          10 |     0.2211 |     0.6946 |     0.2608 | exactly 10; 430 total                                 |
| Corrected answer + ranked list                |          10 |     0.2474 |     0.7044 |     0.2765 | exactly 10; 430 total                                 |
| **Corrected ranked-list-only, count omitted** | **omitted** | **0.3538** | **0.7343** | **0.4339** | **min 3, median 18, mean 23.86, max 73; 1,026 total** |

The key controlled comparison is corrected ranked-list-only with count omitted versus corrected
ranked-list-only at exactly 10. Omitting count improved aggregate nDCG@10 by **0.0397**, from
0.6946 to 0.7343. It also nearly reproduced the historical optional-count result of 0.7381; the
aggregate difference was only -0.0038.

The optional-count ranking lengths were:

```text
3, 3, 3, 3, 5, 6, 10, 10, 10, 10, 12, 12, 12, 13, 14, 15, 15, 16,
17, 17, 18, 18, 20, 20, 20, 20, 22, 24, 25, 27, 34, 37, 38, 39, 40,
40, 46, 49, 49, 49, 51, 61, 73
```

All 43 optional-count lists contained unique document IDs. There were no parse, count, timeout,
or completion errors.

### Paired topic-level analysis

Paired comparisons used per-topic nDCG@10, a 100,000-sample topic bootstrap for the mean
difference confidence interval, and a 200,000-sample paired randomization test with random sign
flips. Positive deltas favor the first condition named.

| Comparison                                      | Mean delta | Wins / losses / ties |  Bootstrap 95% CI | Two-sided p |
| ----------------------------------------------- | ---------: | -------------------: | ----------------: | ----------: |
| Corrected optional count vs corrected exact-10  |    +0.0397 |          24 / 15 / 4 | [-0.0172, 0.1058] |       0.234 |
| Corrected composed exact-10 vs ranked exact-10  |    +0.0098 |          21 / 20 / 2 | [-0.0507, 0.0782] |       0.790 |
| Corrected exact-10 vs pre-fix exact-10          |    -0.0202 |          18 / 22 / 3 | [-0.0729, 0.0296] |       0.464 |
| Corrected optional count vs historical optional |    -0.0038 |          19 / 18 / 6 | [-0.0589, 0.0534] |       0.897 |

None of these single-run paired differences is statistically significant on 43 topics. The
evidence should therefore be read as an ablation pattern, not as proof of a 0.0397 population
effect. The important observations are that both optional-count runs independently reached about
0.74 nDCG@10, both corrected exact-10 runs remained near 0.70, and composing answer with ranked
list did not cause a consistent loss under the matched corrected prompt.

### Behavioral evidence and interpretation

The corrected optional-count agent did more retrieval work than corrected exact-10 ranked-list
only:

| Condition               | Tool calls | Search calls | Document reads | Sum elapsed seconds |
| ----------------------- | ---------: | -----------: | -------------: | ------------------: |
| Corrected exact-10      |        501 |          180 |            321 |             1,434.3 |
| Corrected count omitted |        628 |          202 |            426 |             1,697.5 |

The optional-count run used 25% more tool calls, 12% more searches, and 33% more document reads.
Its system-surfaced macro recall was 0.5283, compared with the shallower exact-10 behavior. This
supports the following mechanism: when asked for exactly 10 documents, the model can satisfy the
task as soon as it has ten plausible candidates; when allowed to choose the output length, it
continues gathering alternatives and then constructs a better-considered top ten. The effect is
therefore upstream of TREC serialization. Truncating a deep, already-produced ranking to 10 would
leave nDCG@10 unchanged, whereas prompting the agent to produce exactly 10 changes how it searches.

Other explanations remain possible. These are stochastic agent runs, the prompt wording differs
between exact and optional conditions, and the optional condition permits more output tokens. A
larger repeated-run study would be required to separate stopping behavior, candidate-set breadth,
and token-budget effects.

### Recommendation

- Keep `RANKED_LIST_COUNT` optional in APIs, environment variables, and CLI launchers.
- Use omitted count as the default agent-retrieval condition; `RANKED_LIST_DEPTH` remains a safety
  maximum rather than a target.
- Treat exact count as a substantive retrieval ablation and label it in run names and metadata.
- If a downstream consumer needs exactly 10 documents without changing agent behavior, first run
  the optional-count condition and deterministically truncate the produced TREC ranking to 10.
- Compare answer + ranked list against ranked-list-only under the same count policy. The matched
  corrected exact-10 comparison provides no evidence that modular output composition itself harms
  nDCG@10.

### Run artifacts

- Corrected exact-10 ranked-list-only:
  `runs/msmarco-v1-passage-dl19-judged-ranked-top10-corrected-gpt55-pyserini-rest-2tool/merged`
- Corrected exact-10 answer + ranked list:
  `runs/msmarco-v1-passage-dl19-judged-answer-ranked-top10-corrected-gpt55-pyserini-rest-2tool/merged`
- Corrected optional-count ranked-list-only:
  `runs/msmarco-v1-passage-dl19-judged-ranked-optional-corrected-gpt55-pyserini-rest-2tool/merged`
- Evaluation summaries mirror those paths under `evals/retrieval/msmarco-v1-passage/`.
