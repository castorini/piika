import assert from "node:assert/strict";
import test from "node:test";

import {
  boundJudgedResponse,
  resolveJudgeMaxResponseChars,
} from "../src/evaluation/judge_response_bound";

void test("the judge answer bound is off unless PIIKA_JUDGE_MAX_RESPONSE_CHARS is set", () => {
  assert.equal(resolveJudgeMaxResponseChars({}), undefined);
  assert.equal(resolveJudgeMaxResponseChars({ PIIKA_JUDGE_MAX_RESPONSE_CHARS: "20000" }), 20000);
  assert.throws(
    () => resolveJudgeMaxResponseChars({ PIIKA_JUDGE_MAX_RESPONSE_CHARS: "lots" }),
    /PIIKA_JUDGE_MAX_RESPONSE_CHARS/,
  );
});

void test("a bounded answer keeps head and tail and drops NUL bytes", () => {
  assert.equal(boundJudgedResponse("short\0 answer", 100), "short answer");
  const long = `${"a".repeat(50)}Exact Answer: x`;
  const bounded = boundJudgedResponse(long, 20);
  assert.ok(bounded.startsWith("a".repeat(10)));
  assert.ok(bounded.endsWith("Answer: x"));
  assert.match(bounded, /\[\.\.\. 45 characters omitted \.\.\.\]/);
});
