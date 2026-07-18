import assert from "node:assert/strict";
import test from "node:test";

import { formatPiSearchPrompt } from "../src/pi-search/agent_prompt";

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
