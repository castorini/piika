import assert from "node:assert/strict";
import test from "node:test";

import { parseRankedDocidsFromAssistantText } from "../src/evaluation/ranked_list_output";

void test("ranked-list parser isolates the composed ranked-list section", () => {
  const response = `Answer:
Explanation: The answer has two supporting points [d1].
Exact Answer: alpha
Confidence: 90%

Ranked List:
1. d1
2. d2`;

  assert.deepEqual(parseRankedDocidsFromAssistantText(response), { docids: ["d1", "d2"] });
});
