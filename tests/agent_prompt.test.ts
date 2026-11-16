import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPiSearchPrompt,
  formatPiSearchPromptWithSuppliedContext,
  parsePiSearchOutputModes,
} from "../src/pi-search/agent_prompt";

void test("ranked-list prompt requests an exact count when configured", () => {
  const prompt = formatPiSearchPrompt("alpha", "plain_minimal", {
    outputMode: "ranked_list",
    rankedListDepth: 100,
    rankedListCount: 30,
  });

  assert.match(prompt, /Return exactly 30 unique document ids/);
  assert.match(prompt, /do not return fewer than 30/);
});

void test("ranked-list prompt preserves up-to-depth behavior without an exact count", () => {
  const prompt = formatPiSearchPrompt("alpha", "plain_minimal", {
    outputMode: "ranked_list",
    rankedListDepth: 50,
  });

  assert.match(prompt, /up to 50 document ids/);
  assert.doesNotMatch(prompt, /Return exactly/);
});

void test("answer and ranked-list outputs compose from the two atomic modes", () => {
  const prompt = formatPiSearchPrompt("alpha", "plain_minimal", {
    outputModes: parsePiSearchOutputModes("answer+ranked_list"),
    rankedListCount: 3,
  });

  assert.match(prompt, /Answer output:/);
  assert.match(prompt, /Ranked-list output:/);
  assert.match(prompt, /Answer:\nExplanation:/);
  assert.match(prompt, /Ranked List:\n1\. \{docid\}/);
  assert.match(prompt, /same research pass for all outputs/);
});

void test("output mode composition deduplicates atoms", () => {
  assert.deepEqual(parsePiSearchOutputModes("answer,ranked_list+answer"), [
    "answer",
    "ranked_list",
  ]);
});

void test("prompt defaults to the direct two-tool workflow", () => {
  const prompt = formatPiSearchPrompt("alpha");

  assert.match(prompt, /ranked hits returned directly by search/);
  assert.doesNotMatch(prompt, /read_search_results/);
  assert.doesNotMatch(prompt, /offset=1/);
});

void test("three-tool workflow remains an explicit opt-in", () => {
  const prompt = formatPiSearchPrompt("alpha", "plain_minimal", {
    toolInterface: "pi-serini-3tool",
  });

  assert.match(prompt, /Browse the current ranking with read_search_results/);
  assert.match(prompt, /offset=1/);
});

void test("the closing format line mentions ranked document lines only when a ranked list is requested", () => {
  const closing = "between those sections beyond the requested fields";
  const builders = [
    (modes: ("answer" | "ranked_list")[]) =>
      formatPiSearchPrompt("alpha", "plain_minimal", { outputModes: modes }),
    (modes: ("answer" | "ranked_list")[]) =>
      formatPiSearchPromptWithSuppliedContext("alpha", "ctx", { outputModes: modes }),
  ];
  for (const build of builders) {
    assert.ok(build(["answer"]).includes(`${closing}.\n`));
    assert.ok(!build(["answer"]).includes("ranked document lines"));
    assert.ok(build(["ranked_list"]).includes(`${closing} and ranked document lines.\n`));
    assert.ok(build(["answer", "ranked_list"]).includes(`${closing} and ranked document lines.\n`));
  }
});
