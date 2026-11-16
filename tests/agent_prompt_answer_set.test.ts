import assert from "node:assert/strict";
import test from "node:test";

import { formatPiSearchPrompt } from "../src/pi-search/agent_prompt";

void test("the complete-answer-set line is added only with PI_SEARCH_COMPLETE_ANSWER_SET=1", () => {
  const previous = process.env.PI_SEARCH_COMPLETE_ANSWER_SET;
  try {
    delete process.env.PI_SEARCH_COMPLETE_ANSWER_SET;
    const plain = formatPiSearchPrompt("alpha", "plain_minimal", { outputModes: ["answer"] });
    assert.ok(!plain.includes("complete set of answers"));
    process.env.PI_SEARCH_COMPLETE_ANSWER_SET = "1";
    const withSet = formatPiSearchPrompt("alpha", "plain_minimal", { outputModes: ["answer"] });
    assert.ok(
      withSet.includes(
        "- Keep Exact Answer directly responsive to the question.\n- Provide the complete set of answers",
      ),
    );
    assert.equal(withSet.replace(/\n- Provide the complete set of answers[^\n]*/, ""), plain);
  } finally {
    if (previous === undefined) delete process.env.PI_SEARCH_COMPLETE_ANSWER_SET;
    else process.env.PI_SEARCH_COMPLETE_ANSWER_SET = previous;
  }
});
