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
