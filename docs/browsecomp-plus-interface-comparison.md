# BrowseComp-Plus Interface Comparison

This doc compares BrowseComp-Plus runs that hold model and timeout fixed while changing the agent-facing search interface.

For a fresh-session overview, start with [BrowseComp-Plus Agent Guide](./browsecomp-plus-agent.md).

## Contents

Cursor note: use the exact heading text below with symbol search / outline search; markdown anchor links are intentionally avoided here.

| Run setting                                                 | Go to heading                        |
| ----------------------------------------------------------- | ------------------------------------ |
| `q100`, GPT-5.4, 300s, default BM25, 3-tool vs REST 2-tool  | `Default BM25 q100: GPT-5.4 / 300s`  |
| `q100`, GPT-5.4, 300s, tuned BM25, 3-tool vs REST 2-tool    | `Tuned BM25 q100: GPT-5.4 / 300s`    |
| `qfull`, GPT-5.5, 300s, default BM25, 3-tool vs REST 2-tool | `Default BM25 qfull: GPT-5.5 / 300s` |
| `qfull`, GPT-5.5, 300s, tuned BM25, 3-tool vs REST 2-tool   | `Tuned BM25 qfull: GPT-5.5 / 300s`   |
| Older context: `q100`, GPT-5.5, 900s, 3-tool vs REST 2-tool | `Older q100 Context: GPT-5.5 / 900s` |
| Metric definitions and reporting rules                      | `Metric Glossary`; `Reporting Rule`  |

## Bottom Line

The paper-style 3-tool condition reproduces the paper's q100 accuracy and evidence metrics closely. With paper BM25 params, the Pyserini REST 2-tool condition has lower `system-surfaced` recall but much higher judged answer accuracy because every search hit surfaced by REST is directly visible to the agent.

With tuned BrowseComp-Plus BM25 (`k1=25`, `b=1`), both interfaces improve sharply. REST still wins on judged answer accuracy, but the gap narrows from +15.00 pp overall to +7.00 pp overall, while the 3-tool interface regains a large system-surfaced recall advantage.

On the full `qfull` set with GPT-5.5, 300s timeout, and default BM25, the same high-level pattern holds: 3-tool has much higher system-surfaced recall, while REST has higher judged answer accuracy and higher behavior recall. REST wins answer accuracy by +5.06 pp overall / +5.14 pp completed-only, despite surfacing far fewer relevant labels at the system level, but costs +216.20M agent tokens and +$173.37 agent model cost.

On the full `qfull` set with GPT-5.5, 300s timeout, and tuned BM25, REST again wins answer accuracy, this time by +5.42 pp overall / +2.75 pp completed-only. The tuned 3-tool run stays close to the paper headline and has much higher system-surfaced recall, but REST has 26 fewer timeouts, higher previewed and behavior recall, fewer tool calls, and lower summed elapsed time. REST's visible search results still carry a cost: +92.73M agent tokens and +$59.87 agent model cost.

## Default BM25 q100: GPT-5.4 / 300s

Shared settings:

- Model: `openai-codex/gpt-5.4`
- Timeout: 300s
- Query set: repo-generated `q100`
- BM25: `k1=0.9`, `b=0.4`
- Judge: gold-answer mode, `openai-codex/gpt-5.3-codex`, low thinking

Conditions:

- A: `runs/repro-gpt54-q100-3tool-shared4`; Pi-Serini 3-tool; custom Anserini BM25 server; completed 97 / 100.
- B: `runs/repro-gpt54-q100-pyserini-rest-2tool-shared4`; Pyserini REST 2-tool; Pyserini REST backend; completed 97 / 100.

Interface note: A exposes `search`, `read_search_results`, and `read_document`. B exposes `search` and `read_document`; its `search` directly returns visible ranked-hit excerpts, so surfaced and previewed recall are identical.

Headline results:

| Metric                          |                   A: 3-tool |              B: REST 2-tool |                             B - A |
| ------------------------------- | --------------------------: | --------------------------: | --------------------------------: |
| Answer accuracy                 |                      65.00% |                      80.00% |                         +15.00 pp |
| Completed-only accuracy         |                      67.01% |                      82.47% |                         +15.46 pp |
| Completed correct / wrong       |                     65 / 32 |                     80 / 17 |                       +15 correct |
| Completed                       |                    97 / 100 |                    97 / 100 |                                 0 |
| Timeouts                        |       `233`, `1005`, `1049` |        `233`, `996`, `1005` |          swapped `1049` for `996` |
| Evidence system-surfaced recall | 86.54% macro / 84.87% micro | 68.61% macro / 64.59% micro | -17.93 pp macro / -20.28 pp micro |
| Evidence agent-previewed recall | 53.67% macro / 50.55% micro | 68.61% macro / 64.59% micro | +14.94 pp macro / +14.04 pp micro |
| Evidence agent-behavior recall  | 39.62% macro / 35.41% micro | 50.73% macro / 45.40% micro |  +11.11 pp macro / +9.99 pp micro |
| Gold system-surfaced recall     | 89.69% macro / 85.24% micro | 76.61% macro / 69.00% micro | -13.08 pp macro / -16.24 pp micro |
| Gold agent-previewed recall     | 61.01% macro / 51.29% micro | 76.61% macro / 69.00% micro | +15.60 pp macro / +17.71 pp micro |
| Gold agent-behavior recall      | 50.86% macro / 37.27% micro | 65.43% macro / 53.14% micro | +14.57 pp macro / +15.87 pp micro |
| Tool calls total                |                        2547 |                        2385 |                              -162 |
| Mean tool calls / query         |                       25.47 |                       23.85 |                             -1.62 |
| Search calls                    |                        2028 |                        1924 |                              -104 |
| Browse calls                    |                          92 |                           0 |                               -92 |
| Read calls                      |                         427 |                         461 |                               +34 |
| Elapsed seconds, summed         |                   16332.588 |                    13145.04 |                         -3187.548 |
| Agent input tokens              |                       6.08M |                      10.24M |                            +4.16M |
| Agent output tokens             |                      470.8K |                      456.1K |                            -14.7K |
| Agent cache-read tokens         |                      29.41M |                      62.18M |                           +32.77M |
| Agent total tokens              |                      35.95M |                      72.87M |                           +36.92M |
| Agent model cost                |                      $29.61 |                      $47.98 |                           +$18.37 |
| Citation precision / recall     |             71.52% / 38.83% |             83.43% / 47.80% |              +11.91 pp / +8.97 pp |
| Judge cost                      |                   $0.295930 |                   $0.296777 |                        +$0.000847 |

Read:

The 3-tool interface has a larger hidden/system-surfaced recall reservoir. On evidence qrels it surfaces 544 / 641 labels, versus 414 / 641 for REST. On gold qrels it surfaces 231 / 271, versus 187 / 271 for REST.

That 3-tool advantage reverses once the metric asks what the model actually saw or used. REST previewed recall equals surfaced recall because direct search exposes all returned hits to the agent. In the same-model run, REST has higher previewed and behavior recall on both evidence and gold qrels.

The judged results make the REST win decisive for this q100 same-model setting: +15.00 percentage points overall answer accuracy and +15.46 percentage points on completed queries. The surprising part is that this happens despite REST surfacing fewer total relevant labels at the system level, which points toward visibility, direct previews, and higher-quality document use mattering more than the hidden candidate reservoir in this setup.

REST's accuracy gain is not free: the run consumed about 2.0x total agent tokens and about 1.6x agent model cost. Most of that difference is cache-read volume, which is consistent with direct search returning more visible text to the model.

## Tuned BM25 q100: GPT-5.4 / 300s

These runs repeat the interface comparison with the BrowseComp-Plus tuned sparse BM25 setting:

- BM25: `k1=25`, `b=1`
- Judge: gold-answer mode, `openai-codex/gpt-5.3-codex`, low thinking
- Condition A: `runs/repro-gpt54-q100-3tool-tuned-shared4`
- Condition B: `runs/repro-gpt54-q100-pyserini-rest-2tool-tuned-shared4`

| Metric                          |             A: 3-tool tuned |        B: REST 2-tool tuned |                             B - A |
| ------------------------------- | --------------------------: | --------------------------: | --------------------------------: |
| Answer accuracy                 |                      78.00% |                      85.00% |                          +7.00 pp |
| Completed-only accuracy         |                      82.11% |                      85.00% |                          +2.89 pp |
| Completed correct / wrong       |                     78 / 17 |                     85 / 15 |                        +7 correct |
| Completed                       |                    95 / 100 |                   100 / 100 |                                +5 |
| Timeout/incomplete              |                           5 |                           0 |                                -5 |
| Evidence system-surfaced recall | 95.55% macro / 95.32% micro | 79.45% macro / 77.54% micro | -16.10 pp macro / -17.78 pp micro |
| Evidence agent-previewed recall | 73.80% macro / 71.45% micro | 79.45% macro / 77.54% micro |   +5.65 pp macro / +6.09 pp micro |
| Evidence agent-behavior recall  | 56.46% macro / 51.79% micro | 56.03% macro / 51.79% micro |   -0.43 pp macro / +0.00 pp micro |
| Gold system-surfaced recall     | 96.63% macro / 95.94% micro | 83.37% macro / 78.23% micro | -13.26 pp macro / -17.71 pp micro |
| Gold agent-previewed recall     | 75.94% macro / 71.22% micro | 83.37% macro / 78.23% micro |   +7.43 pp macro / +7.01 pp micro |
| Gold agent-behavior recall      | 65.29% macro / 57.20% micro | 68.19% macro / 58.30% micro |   +2.90 pp macro / +1.10 pp micro |
| Tool calls total                |                        2422 |                        2205 |                              -217 |
| Mean tool calls / query         |                       24.22 |                       22.05 |                             -2.17 |
| Search calls                    |                        1782 |                        1731 |                               -51 |
| Browse calls                    |                         112 |                           0 |                              -112 |
| Read calls                      |                         528 |                         474 |                               -54 |
| Elapsed seconds, summed         |                   12324.008 |                   11153.977 |                         -1170.031 |
| Agent input tokens              |                       4.77M |                       8.19M |                            +3.42M |
| Agent output tokens             |                      429.1K |                      388.1K |                            -41.0K |
| Agent cache-read tokens         |                      28.58M |                      55.86M |                           +27.28M |
| Agent total tokens              |                      33.78M |                      64.44M |                           +30.66M |
| Agent model cost                |                      $25.50 |                      $40.26 |                           +$14.76 |
| Citation precision / recall     |             84.50% / 51.63% |             85.02% / 50.32% |               +0.52 pp / -1.31 pp |
| Judge cost                      |                   $0.292572 |                   $0.305029 |                        +$0.012457 |

Tuned BM25 changes the story. The 3-tool condition now surfaces almost all labels at the system level and nearly catches REST on completed-only accuracy, but its five timeouts keep overall accuracy lower. REST remains more reliable and highest-accuracy overall, though its token cost remains about 1.6x higher.

## Default BM25 qfull: GPT-5.5 / 300s

These runs repeat the interface comparison on the full repo-generated `qfull` query set:

- Query set: `qfull`, 830 queries
- Model: `openai-codex/gpt-5.5`
- Timeout: 300s
- BM25: `k1=0.9`, `b=0.4`
- Judge: gold-answer mode, `openai-codex/gpt-5.3-codex`, low thinking
- Condition A: `runs/repro-gpt55-qfull-3tool-shared8`
- Condition B: `runs/repro-gpt55-qfull-pyserini-rest-2tool-shared8`

| Metric                          |             A: 3-tool qfull |        B: REST 2-tool qfull |                             B - A |
| ------------------------------- | --------------------------: | --------------------------: | --------------------------------: |
| Answer accuracy                 |                      70.72% |                      75.78% |                          +5.06 pp |
| Completed-only accuracy         |                      71.85% |                      76.99% |                          +5.14 pp |
| Completed                       |                   817 / 830 |                   817 / 830 |                                 0 |
| Timeout/incomplete              |                          13 |                          13 |                                 0 |
| Evidence system-surfaced recall | 86.22% macro / 85.29% micro | 65.21% macro / 63.55% micro | -21.01 pp macro / -21.74 pp micro |
| Evidence agent-previewed recall | 60.14% macro / 57.60% micro | 65.21% macro / 63.55% micro |   +5.07 pp macro / +5.95 pp micro |
| Evidence agent-behavior recall  | 48.21% macro / 44.14% micro | 51.86% macro / 48.24% micro |   +3.65 pp macro / +4.10 pp micro |
| Gold system-surfaced recall     | 89.99% macro / 87.66% micro | 72.64% macro / 68.30% micro | -17.35 pp macro / -19.36 pp micro |
| Gold agent-previewed recall     | 67.72% macro / 62.69% micro | 72.64% macro / 68.30% micro |   +4.92 pp macro / +5.61 pp micro |
| Gold agent-behavior recall      | 58.54% macro / 50.15% micro | 62.77% macro / 54.34% micro |   +4.23 pp macro / +4.19 pp micro |
| Tool calls total                |                       17174 |                       16573 |                              -601 |
| Mean tool calls / query         |                       20.69 |                       19.97 |                             -0.72 |
| Search calls                    |                       12502 |                       12379 |                              -123 |
| Browse calls                    |                         768 |                           0 |                              -768 |
| Read calls                      |                        3904 |                        4194 |                              +290 |
| Elapsed seconds, summed         |                    106010.3 |                     82112.8 |                          -23897.5 |
| Agent input tokens              |                      35.19M |                      49.10M |                           +13.91M |
| Agent output tokens             |                       2.59M |                       2.68M |                            +90.2K |
| Agent cache-read tokens         |                     205.16M |                     407.36M |                          +202.19M |
| Agent total tokens              |                     242.94M |                     459.14M |                          +216.20M |
| Agent model cost                |                     $356.24 |                     $529.61 |                          +$173.37 |
| Calibration error               |                      24.11% |                      22.31% |                          -1.80 pp |
| Citation precision / recall     |             83.25% / 43.85% |             83.98% / 44.37% |               +0.73 pp / +0.52 pp |
| Judge cost                      |                   $2.317516 |                   $2.292955 |                        -$0.024561 |

The full-set result is less dramatic than the q100 GPT-5.4 default-BM25 comparison but points in the same direction. The 3-tool interface's hidden candidate reservoir gives it a large system-surfaced recall advantage: on evidence qrels it surfaces 4319 / 5064 labels versus REST's 3218 / 5064, and on gold qrels it surfaces 2110 / 2407 labels versus REST's 1644 / 2407. REST still converts visible evidence into answers more effectively, with +5.06 pp overall accuracy and modestly higher behavior recall.

REST also finishes with fewer summed elapsed seconds and fewer total tool calls. The qfull agent token totals above were recovered from `merged/raw-events/*.jsonl` by summing `message_end.message.usage` records. Judge cost is reported separately from agent model cost.

## Tuned BM25 qfull: GPT-5.5 / 300s

These runs repeat the full-set comparison with the paper-tuned sparse BM25 setting:

- Query set: `qfull`, 830 queries
- Model: `openai-codex/gpt-5.5`
- Timeout: 300s
- BM25: `k1=25`, `b=1`
- Judge: gold-answer mode, `openai-codex/gpt-5.3-codex`, low thinking
- Condition A: `runs/repro-gpt55-qfull-3tool-tuned-shared8`
- Condition B: `runs/repro-gpt55-qfull-pyserini-rest-2tool-tuned-shared8`

| Metric                          |       A: 3-tool tuned qfull |  B: REST 2-tool tuned qfull |                             B - A |
| ------------------------------- | --------------------------: | --------------------------: | --------------------------------: |
| Answer accuracy                 |                      82.65% |                      88.07% |                          +5.42 pp |
| Completed-only accuracy         |                      85.43% |                      88.18% |                          +2.75 pp |
| Completed correct / wrong       |                   686 / 117 |                    731 / 98 |           +45 correct / -19 wrong |
| Completed                       |                   803 / 830 |                   829 / 830 |                               +26 |
| Timeout/incomplete              |                          27 |                           1 |                               -26 |
| Evidence system-surfaced recall | 93.67% macro / 93.42% micro | 79.12% macro / 79.15% micro | -14.55 pp macro / -14.27 pp micro |
| Evidence agent-previewed recall | 72.47% macro / 71.92% micro | 79.12% macro / 79.15% micro |   +6.65 pp macro / +7.23 pp micro |
| Evidence agent-behavior recall  | 57.08% macro / 54.44% micro | 60.97% macro / 58.45% micro |   +3.89 pp macro / +4.01 pp micro |
| Gold system-surfaced recall     | 96.16% macro / 95.93% micro | 84.89% macro / 83.84% micro | -11.27 pp macro / -12.09 pp micro |
| Gold agent-previewed recall     | 78.28% macro / 76.24% micro | 84.89% macro / 83.84% micro |   +6.61 pp macro / +7.60 pp micro |
| Gold agent-behavior recall      | 66.87% macro / 61.24% micro | 70.98% macro / 64.94% micro |   +4.11 pp macro / +3.70 pp micro |
| Tool calls total                |                       16169 |                       14106 |                             -2063 |
| Mean tool calls / query         |                       19.48 |                       17.00 |                             -2.48 |
| Search calls                    |                       11417 |                       10009 |                             -1408 |
| Browse calls                    |                         697 |                           0 |                              -697 |
| Read calls                      |                        4055 |                        4097 |                               +42 |
| Elapsed seconds, summed         |                   83835.855 |                   60154.055 |                        -23681.800 |
| Agent input tokens              |                      30.06M |                      33.97M |                            +3.91M |
| Agent output tokens             |                       2.31M |                       2.17M |                           -138.8K |
| Agent cache-read tokens         |                     185.42M |                     274.38M |                           +88.96M |
| Agent total tokens              |                     217.80M |                     310.53M |                           +92.73M |
| Agent model cost                |                     $312.36 |                     $372.23 |                           +$59.87 |
| Calibration error               |                      13.77% |                      14.03% |                          +0.26 pp |
| Citation precision / recall     |             90.62% / 48.38% |             92.14% / 50.26% |               +1.52 pp / +1.88 pp |
| Judge cost                      |                   $2.309125 |                   $2.390915 |                        +$0.081790 |

This is the strongest same-model evidence so far that the two interfaces differ mainly in what becomes visible to the agent. Tuned 3-tool exposes a much larger system-level candidate reservoir, including nearly all gold labels, but REST turns its smaller visible result set into better answers. REST also removes almost all incompletes, which accounts for roughly half of the overall accuracy gap: completed-only accuracy differs by +2.75 pp, while overall accuracy differs by +5.42 pp.

The qfull agent token totals above were recovered from `merged/raw-events/*.jsonl` by summing `message_end.message.usage` records. Judge cost is reported separately from agent model cost.

## Metric Glossary

`evidence qrels` are broader evidence-document labels for BrowseComp-Plus.

`gold qrels` are stricter final answer-support labels.

`system-surfaced recall` measures all documents surfaced by the search system during the run. In the 3-tool condition this can include a hidden candidate pool behind `search_id` results.

`agent-previewed recall` measures documents the model actually saw in search previews or result pages.

`agent-behavior recall` measures documents the model opened or cited.

`macro recall` averages per-query recall, so each query contributes equally.

`micro recall` pools all labels across all queries, so queries with more labels contribute more weight.

`elapsed seconds (sum)` is the sum of per-query elapsed times across shards, not wall-clock runtime.

## Reporting Rule

Use these paper-aligned metrics as headline metrics:

- answer accuracy
- calibration error, when available
- system-surfaced recall
- agent-previewed recall
- agent-behavior recall
- tool calls
- elapsed time
- token/cost accounting

Do not headline recall@100, recall@1000, nDCG@10, MRR@10, or MAP. Those prefix metrics depend on how each interface constructs the final accumulated `surfaced_docids` sequence and are not cleanly comparable across 3-tool and 2-tool modes.

Usage accounting rule: always include agent token counts and agent model cost in interface-comparison tables. If generated `report.md` files do not include token totals, recover agent-run usage from `merged/raw-events/*.jsonl` by summing `message_end.message.usage`. Do not sum every nested `usage` object, because `message_update`, `message_end`, and `turn_end` events can duplicate the same provider usage. Keep judge cost separate from agent model cost.

## Older q100 Context: GPT-5.5 / 900s

These runs are useful context but are not the paper-comparable condition because they use GPT-5.5 and a 900s timeout.

| Condition | Run                                                 | Interface            | Status        |
| --------- | --------------------------------------------------- | -------------------- | ------------- |
| A         | `runs/repro-gpt55-q100-3tool-shared4`               | Pi-Serini 3-tool     | completed=100 |
| B         | `runs/repro-gpt55-q100-pyserini-rest-2tool-shared4` | Pyserini REST 2-tool | completed=100 |

| Metric                         | A: 3-tool | B: REST 2-tool |     B - A |
| ------------------------------ | --------: | -------------: | --------: |
| Evidence system-surfaced macro |    89.36% |         65.63% | -23.73 pp |
| Evidence agent-previewed macro |    64.15% |         65.63% |  +1.48 pp |
| Evidence agent-behavior macro  |    50.82% |         51.22% |  +0.40 pp |
| Gold system-surfaced macro     |    94.20% |         79.56% | -14.64 pp |
| Gold agent-previewed macro     |    76.37% |         79.56% |  +3.19 pp |
| Gold agent-behavior macro      |    64.77% |         66.54% |  +1.77 pp |
| Tool calls total               |      2223 |           1832 |      -391 |
| Mean tool calls / query        |      22.2 |           18.3 |      -3.9 |
| Elapsed seconds, summed        |   12424.7 |         8565.7 |   -3859.0 |
| Reported model cost            |    $54.81 |         $61.54 |    +$6.73 |

The GPT-5.5 comparison shows the same broad shape as GPT-5.4: 3-tool has higher system-surfaced recall, while REST is comparable or slightly higher on previewed and behavior recall.

## Recommended Next Checks

- Compare per-query answer outcomes against per-query behavior recall.
- Inspect REST wins where A surfaced relevant docs but answered incorrectly.
- Inspect the smaller set of 3-tool wins where REST answered incorrectly.
- Inspect queries where A surfaced relevant docs but B missed them entirely.
- Inspect queries where B found relevant docs earlier or used fewer tools.
- Consider normalizing `surfaced_docids` semantics before making strong claims from system-surfaced recall alone.
