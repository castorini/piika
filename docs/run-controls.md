# Opt-in run controls

Each control below is off unless its environment variable is set; with none set, prompts,
tool schemas, provider payloads, REST traffic, run records, and judge inputs are exactly
what they are without them. The benchmark runner passes its environment to every pi
process, so setting a variable for the runner sets it for the agent too.

## Agent loop guards

| Variable                                 | Effect                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS=<n>` | Once an assistant turn that calls tools brings the context (prompt + output) to `n` tokens, queue a "context budget" submit-now steer and block further retrieval calls, like the existing time-budget steer at 70% of `TIMEOUT_SECONDS`. Answering turns never trigger it. |
| `PI_SEARCH_BLOCK_REPEAT_QUERIES=1`       | Refuse a `search` whose query (whitespace-normalised, case kept) the agent already issued in this session; the model gets a note instead of the same hits.                                                                                                                  |
| `PI_SEARCH_NO_REPEAT_QUERY_RULE=1`       | Append "never issue a search query you have already issued" to workflow rule 6.                                                                                                                                                                                             |
| `PI_SEARCH_REFINE_RULE_V2=1`             | Replace workflow rule 6: refine with a different query when the evidence is missing; never repeat an identical query. Alternative to the previous one (setting both is an error).                                                                                           |

## Provider requests

| Variable                                                  | Effect                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SEARCH_MAX_OUTPUT_TOKENS=<n>`                         | Per-turn output cap in every provider payload (pi otherwise sends `min(model.maxTokens, 32000)`).                                                                   |
| `PI_SEARCH_SAMPLING_OVERRIDES='{"presence_penalty":0.1}'` | Numeric sampling fields merged into every payload: `temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `frequency_penalty`, `repetition_penalty`, `seed`. |

## Search tool and prompt

| Variable                          | Effect                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SEARCH_MAX_HITS=<n>`          | Cap `hits` per direct search at `n` (1–100). When set, the `hits` parameter and its guidance line are withheld from the model, so `n`, or the default 5 if lower, is used on every call. |
| `PI_SEARCH_COMPLETE_ANSWER_SET=1` | Add an answer instruction asking for the complete set of answers as a JSON array, for benchmarks whose answers are sets.                                                                 |

## Pyserini REST backend

| Variable                             | Effect                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PYSERINI_REST_MAX_CONCURRENT=<n>`   | Requests in flight per agent process (default: no cap).                                                                                                                            |
| `PYSERINI_REST_MIN_INTERVAL_MS=<ms>` | Minimum time between request starts per agent process (default: no pacing).                                                                                                        |
| `PYSERINI_REST_MAX_ATTEMPTS=<n>`     | Attempts per request on network errors and HTTP 429/502/503/504, with exponential backoff from 1 s (capped at 30 s, jittered) that honours `Retry-After` (default: 1, no retries). |

The same settings are `maxConcurrentRequests`, `minRequestIntervalMs`, and `maxAttempts` in a
`pyserini-rest` backend config.

## Failure handling and run records

| Variable                             | Effect                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PI_SEARCH_FAIL_FAST=1`              | A retrieval or rerank failure (after its own retries) ends the pi process with exit code 75 and a `[pi-search] FATAL kind=... tool=... message=...` line instead of reaching the model as a tool error. The runner records `status: "failed"` with `failure.kind` = `retrieval_error`, `rerank_error`, or `agent_inference_error` (the agent's LLM call failed after pi's own retries), and `stats.agent_retries`. |
| `PIIKA_RECORD_AGENT_USAGE=1`         | Sum the token usage and cost pi reports per assistant message into `stats.usage` of each run record.                                                                                                                                                                                                                                                                                                               |
| `PIIKA_JUDGE_MAX_RESPONSE_CHARS=<n>` | Before judging, drop NUL bytes from the answer and keep its first and last `n/2` characters when it is longer than `n`.                                                                                                                                                                                                                                                                                            |

## Example: a guarded run

```bash
export PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS=206438     # 90% of a 262,144-token context minus 32,768 output
export PI_SEARCH_BLOCK_REPEAT_QUERIES=1 PI_SEARCH_REFINE_RULE_V2=1
export PI_SEARCH_SAMPLING_OVERRIDES='{"presence_penalty":0.1}' PI_SEARCH_MAX_OUTPUT_TOKENS=32768
export PI_SEARCH_MAX_HITS=5
export PYSERINI_REST_MAX_CONCURRENT=2 PYSERINI_REST_MAX_ATTEMPTS=8
export PI_SEARCH_FAIL_FAST=1 PIIKA_RECORD_AGENT_USAGE=1 PIIKA_JUDGE_MAX_RESPONSE_CHARS=20000
```
