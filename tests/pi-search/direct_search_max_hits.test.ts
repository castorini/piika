import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectSearchParamsPinnedSchema,
  DirectSearchParamsSchema,
} from "../../src/pi-search/protocol/schemas";
import {
  isDirectSearchHitsCapped,
  normalizeDirectSearchLimitForTest,
} from "../../src/pi-search/tool_handlers";

void test("PI_SEARCH_MAX_HITS caps the hits a model may request", () => {
  const previous = process.env.PI_SEARCH_MAX_HITS;
  try {
    delete process.env.PI_SEARCH_MAX_HITS;
    assert.equal(normalizeDirectSearchLimitForTest(undefined), 5, "default k");
    assert.equal(normalizeDirectSearchLimitForTest(50), 50, "uncapped by default");
    process.env.PI_SEARCH_MAX_HITS = "5";
    assert.equal(normalizeDirectSearchLimitForTest(50), 5, "pinned to the cap");
    assert.equal(normalizeDirectSearchLimitForTest(undefined), 5);
    process.env.PI_SEARCH_MAX_HITS = "abc";
    assert.throws(() => normalizeDirectSearchLimitForTest(10), /PI_SEARCH_MAX_HITS/);
  } finally {
    if (previous === undefined) delete process.env.PI_SEARCH_MAX_HITS;
    else process.env.PI_SEARCH_MAX_HITS = previous;
  }
});

void test("a pinned k withholds the hits parameter from the model", () => {
  assert.ok("hits" in DirectSearchParamsSchema.properties);
  assert.ok(!("hits" in DirectSearchParamsPinnedSchema.properties));
  const previous = process.env.PI_SEARCH_MAX_HITS;
  try {
    delete process.env.PI_SEARCH_MAX_HITS;
    assert.equal(isDirectSearchHitsCapped(), false);
    process.env.PI_SEARCH_MAX_HITS = "5";
    assert.equal(isDirectSearchHitsCapped(), true);
  } finally {
    if (previous === undefined) delete process.env.PI_SEARCH_MAX_HITS;
    else process.env.PI_SEARCH_MAX_HITS = previous;
  }
});
