import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentContextStore,
  extractLatestThinking,
  resolveGlobalQuery,
  trimTrace,
} from "../../src/pi-search/agent_context";

const assistant = (content: unknown[]) => ({
  type: "message",
  message: { role: "assistant", content },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const toolResult = () => ({
  type: "message",
  message: { role: "toolResult", toolCallId: "1", content: [] },
});

void test("extracts thinking from the most recent assistant message", () => {
  const entries = [
    user("question"),
    assistant([{ type: "thinking", thinking: "older turn" }]),
    toolResult(),
    assistant([
      { type: "thinking", thinking: "need the hospital name" },
      { type: "toolCall", id: "c1", name: "search", arguments: {} },
    ]),
  ];
  assert.equal(extractLatestThinking(entries), "need the hospital name");
});

void test("joins multiple thinking blocks within one message", () => {
  const entries = [
    assistant([
      { type: "thinking", thinking: "first" },
      { type: "text", text: "ignored" },
      { type: "thinking", thinking: "second" },
    ]),
  ];
  assert.equal(extractLatestThinking(entries), "first\nsecond");
});

void test("returns empty when the latest assistant message has no thinking", () => {
  const entries = [
    assistant([{ type: "thinking", thinking: "older" }]),
    toolResult(),
    assistant([{ type: "toolCall", id: "c1", name: "search", arguments: {} }]),
  ];
  assert.equal(
    extractLatestThinking(entries),
    "",
    "must not fall back to an earlier turn's reasoning, which motivated a different query",
  );
});

void test("returns empty for a session with no assistant messages", () => {
  assert.equal(extractLatestThinking([user("only a question")]), "");
  assert.equal(extractLatestThinking([]), "");
});

void test("trimTrace keeps the head and respects a word boundary", () => {
  assert.equal(trimTrace("short", 100), "short");
  const trimmed = trimTrace("alpha beta gamma delta", 12);
  assert.ok(trimmed.length <= 12);
  assert.ok(
    "alpha beta gamma delta".startsWith(trimmed),
    "must keep the beginning, matching how the field is truncated at training time",
  );
  assert.ok(!trimmed.endsWith(" "));
  assert.equal(trimmed, "alpha beta");
});

void test("store hands each trace to exactly one tool call", () => {
  const store = new AgentContextStore(1000);
  const entries = [assistant([{ type: "thinking", thinking: "why I searched" }])];
  store.record("call-1", entries);
  assert.equal(store.size, 1);
  assert.equal(store.take("call-1"), "why I searched");
  assert.equal(store.take("call-1"), "", "a consumed trace must not be reused");
  assert.equal(store.size, 0);
});

void test("store returns empty for an unknown tool call", () => {
  assert.equal(new AgentContextStore(1000).take("missing"), "");
});

void test("global query comes from the environment", () => {
  assert.equal(resolveGlobalQuery({ PI_SEARCH_GLOBAL_QUERY: "  the question  " }), "the question");
  assert.equal(resolveGlobalQuery({}), "");
});
