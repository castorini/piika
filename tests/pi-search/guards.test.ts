import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPiSearchPrompt,
  NO_REPEAT_QUERY_RULE,
  REFINEMENT_RULE_V2,
} from "../../src/pi-search/agent_prompt";
import { buildMockExtensionConfig } from "../../src/pi-search/config";
import { registerPiSearchExtension } from "../../src/pi-search/extension";
import {
  CONTEXT_SUBMIT_NOW_BLOCK_REASON,
  CONTEXT_SUBMIT_NOW_STEER_MESSAGE,
  contextTokensAfterTurn,
  normalizeSearchQuery,
  REPEAT_QUERY_BLOCK_MESSAGE,
  resolveSubmitNowPromptTokens,
  SUBMIT_NOW_STEER_MESSAGE,
} from "../../src/pi-search/prompt_policy";

const GUARD_ENV = [
  "PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS",
  "PI_SEARCH_BLOCK_REPEAT_QUERIES",
  "PI_SEARCH_NO_REPEAT_QUERY_RULE",
  "PI_SEARCH_REFINE_RULE_V2",
  "PI_SEARCH_RERANK_CONFIG",
  "TIMEOUT_SECONDS",
] as const;

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function withEnv<T>(values: Partial<Record<(typeof GUARD_ENV)[number], string>>, fn: () => T): T {
  const saved = Object.fromEntries(GUARD_ENV.map((key) => [key, process.env[key]]));
  for (const key of GUARD_ENV) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const key of GUARD_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: () => {},
    sendUserMessage: (content: unknown, options: unknown) => {
      sent.push({ content, options });
    },
  };
  const fire = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      result = (await handler(event, { isIdle: () => false })) ?? result;
    }
    return result;
  };
  return { pi, handlers, sent, fire };
}

function register(env: Partial<Record<(typeof GUARD_ENV)[number], string>>) {
  const fake = fakePi();
  withEnv(env, () =>
    registerPiSearchExtension(fake.pi as never, {
      toolInterface: "pyserini-rest-2tool",
      resolveConfig: () => buildMockExtensionConfig({ documents: [] }),
    }),
  );
  return fake;
}

const search = (query: string) => ({
  type: "tool_call",
  toolName: "search",
  toolCallId: "c",
  input: { reason: "r", query },
});

function assistant(totalTokens: number, withToolCall: boolean) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: withToolCall ? [{ type: "thinking" }, { type: "toolCall" }] : [{ type: "text" }],
      usage: { input: 10, output: 5, cacheRead: totalTokens - 15, cacheWrite: 0, totalTokens },
    },
  };
}

void test("repeated search queries pass through when the block is off (default)", async () => {
  const { fire } = register({});
  assert.equal(await fire("tool_call", search("alpha beta")), undefined);
  assert.equal(await fire("tool_call", search("alpha beta")), undefined);
});

void test("an exact repeat of an earlier search query is blocked; new queries and reads are not", async () => {
  const { fire } = register({ PI_SEARCH_BLOCK_REPEAT_QUERIES: "1" });
  assert.equal(await fire("tool_call", search("alpha beta")), undefined);
  assert.deepEqual(await fire("tool_call", search("  alpha   beta ")), {
    block: true,
    reason: REPEAT_QUERY_BLOCK_MESSAGE,
  });
  assert.equal(await fire("tool_call", search("Alpha beta")), undefined);
  assert.equal(await fire("tool_call", search("alpha beta gamma")), undefined);
  const read = {
    type: "tool_call",
    toolName: "read_document",
    toolCallId: "d",
    input: { reason: "r", docid: "1" },
  };
  assert.equal(await fire("tool_call", read), undefined);
  assert.equal(await fire("tool_call", read), undefined);
});

void test("no prompt-size trigger is registered when the threshold is unset (default)", () => {
  const { handlers } = register({});
  assert.equal(handlers.has("message_end"), false);
});

void test("the prompt-size trigger steers and blocks retrieval once a tool-calling turn reaches the threshold", async () => {
  const { fire, sent } = register({ PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS: "1000" });
  await fire("message_end", assistant(999, true));
  assert.equal(sent.length, 0);
  assert.equal(await fire("tool_call", search("alpha")), undefined);

  await fire("message_end", assistant(1000, true));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content, CONTEXT_SUBMIT_NOW_STEER_MESSAGE);
  assert.match(String(sent[0]?.content), /^Context budget is nearly exhausted/);
  assert.doesNotMatch(String(sent[0]?.content), /[Tt]ime/);
  assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });
  const blocked = (await fire("tool_call", search("beta"))) as { block?: boolean; reason?: string };
  assert.deepEqual(blocked, { block: true, reason: CONTEXT_SUBMIT_NOW_BLOCK_REASON });

  await fire("message_end", assistant(5000, true));
  assert.equal(sent.length, 1, "the steer is queued once");
});

void test("an answering turn over the threshold does not trigger the steer", async () => {
  const { fire, sent } = register({ PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS: "1000" });
  await fire("message_end", assistant(5000, false));
  await fire("message_end", { type: "message_end", message: { role: "toolResult", content: [] } });
  assert.equal(sent.length, 0);
});

void test("the time-budget steer text is unchanged", () => {
  assert.equal(
    SUBMIT_NOW_STEER_MESSAGE,
    [
      "Time budget is nearly exhausted.",
      "Further retrieval is now blocked to preserve time for submission.",
      "Stop using tools immediately and submit your best answer right now.",
      "Your final response must use exactly this format:",
      "Explanation: {your explanation for your final answer. Cite supporting docids inline in square brackets [] at the end of sentences when possible, for example [123].}",
      "Exact Answer: {your succinct, final answer}",
      "Confidence: {your confidence score between 0% and 100%}",
    ].join("\n"),
  );
});

void test("threshold parsing and token accounting", () => {
  assert.equal(resolveSubmitNowPromptTokens({}), null);
  assert.equal(
    resolveSubmitNowPromptTokens({ PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS: "206438" }),
    206438,
  );
  assert.throws(
    () => resolveSubmitNowPromptTokens({ PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS: "0.9" }),
    /positive integer/,
  );
  assert.throws(
    () => resolveSubmitNowPromptTokens({ PI_SEARCH_SUBMIT_NOW_PROMPT_TOKENS: "-5" }),
    /positive integer/,
  );
  assert.equal(
    contextTokensAfterTurn({
      input: 2869,
      output: 860,
      cacheRead: 215472,
      cacheWrite: 0,
      totalTokens: 219201,
    }),
    219201,
  );
  assert.equal(contextTokensAfterTurn({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
  assert.equal(normalizeSearchQuery("  a \n b  "), "a b");
  assert.equal(normalizeSearchQuery("   "), null);
  assert.equal(normalizeSearchQuery(undefined), null);
});

void test("the no-repeat rule is appended to workflow rule 6 only when enabled", () => {
  const off = withEnv({}, () =>
    formatPiSearchPrompt("q", "plain_minimal", { toolInterface: "pyserini-rest-2tool" }),
  );
  const on = withEnv({ PI_SEARCH_NO_REPEAT_QUERY_RULE: "1" }, () =>
    formatPiSearchPrompt("q", "plain_minimal", { toolInterface: "pyserini-rest-2tool" }),
  );
  assert.doesNotMatch(off, /Never issue a search query/);
  assert.equal(
    on,
    off.replace(
      "6. Use search refinements only when they add a genuinely new clue from what you already saw.",
      `6. Use search refinements only when they add a genuinely new clue from what you already saw. ${NO_REPEAT_QUERY_RULE}`,
    ),
  );
});

void test("the v2 rule 6 replaces rule 6 whole, only when enabled, and excludes the appended rule", () => {
  const prompt = (env: Partial<Record<(typeof GUARD_ENV)[number], string>>) =>
    withEnv(env, () =>
      formatPiSearchPrompt("q", "plain_minimal", { toolInterface: "pyserini-rest-2tool" }),
    );
  const off = prompt({});
  const v2 = prompt({ PI_SEARCH_REFINE_RULE_V2: "1" });
  assert.equal(
    v2,
    off.replace(
      "6. Use search refinements only when they add a genuinely new clue from what you already saw.",
      REFINEMENT_RULE_V2,
    ),
  );
  assert.notEqual(v2, off);
  assert.match(v2, /\n6\. When the results so far do not give you the evidence you need/);
  assert.doesNotMatch(v2, /genuinely new clue/);
  assert.match(v2, /Never issue a search query identical to one you have already issued;/);
  assert.throws(
    () => prompt({ PI_SEARCH_REFINE_RULE_V2: "1", PI_SEARCH_NO_REPEAT_QUERY_RULE: "1" }),
    /alternative rule-6 edits/,
  );
});
