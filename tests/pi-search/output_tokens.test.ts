import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMaxOutputTokens,
  applySamplingOverrides,
  resolveMaxOutputTokens,
  resolveSamplingOverrides,
} from "../../src/pi-search/output_tokens";

void test("resolveMaxOutputTokens is undefined when unset or blank", () => {
  assert.equal(resolveMaxOutputTokens({}), undefined);
  assert.equal(resolveMaxOutputTokens({ PI_SEARCH_MAX_OUTPUT_TOKENS: "  " }), undefined);
});

void test("resolveMaxOutputTokens parses a positive integer and rejects anything else", () => {
  assert.equal(resolveMaxOutputTokens({ PI_SEARCH_MAX_OUTPUT_TOKENS: "32768" }), 32768);
  for (const bad of ["0", "-5", "1.5", "abc"]) {
    assert.throws(
      () => resolveMaxOutputTokens({ PI_SEARCH_MAX_OUTPUT_TOKENS: bad }),
      /must be a positive integer/,
    );
  }
});

void test("applyMaxOutputTokens replaces the field pi set and leaves the rest untouched", () => {
  const payload = { model: "m", stream: true, max_completion_tokens: 32000, messages: [] };
  assert.deepEqual(applyMaxOutputTokens(payload, 32768), {
    ...payload,
    max_completion_tokens: 32768,
  });
  assert.equal(payload.max_completion_tokens, 32000, "input payload is not mutated");
  assert.deepEqual(applyMaxOutputTokens({ max_tokens: 32000 }, 32768), { max_tokens: 32768 });
});

void test("applyMaxOutputTokens adds max_tokens when the payload carries no cap", () => {
  assert.deepEqual(applyMaxOutputTokens({ model: "m" }, 32768), { model: "m", max_tokens: 32768 });
});

void test("applyMaxOutputTokens returns non-object payloads unchanged", () => {
  assert.equal(applyMaxOutputTokens(undefined, 10), undefined);
  assert.equal(applyMaxOutputTokens("x", 10), "x");
});

void test("resolveSamplingOverrides is undefined when unset, blank or empty", () => {
  assert.equal(resolveSamplingOverrides({}), undefined);
  assert.equal(resolveSamplingOverrides({ PI_SEARCH_SAMPLING_OVERRIDES: " " }), undefined);
  assert.equal(resolveSamplingOverrides({ PI_SEARCH_SAMPLING_OVERRIDES: "{}" }), undefined);
});

void test("resolveSamplingOverrides accepts numeric sampling fields", () => {
  assert.deepEqual(
    resolveSamplingOverrides({
      PI_SEARCH_SAMPLING_OVERRIDES: '{"presence_penalty": 1.0, "top_p": 0.95}',
    }),
    { presence_penalty: 1.0, top_p: 0.95 },
  );
});

void test("resolveSamplingOverrides rejects bad JSON, unknown fields and non-numbers", () => {
  for (const bad of ["not json", "[1]", '{"max_tokens": 5}', '{"presence_penalty": "1"}']) {
    assert.throws(() => resolveSamplingOverrides({ PI_SEARCH_SAMPLING_OVERRIDES: bad }));
  }
});

void test("applySamplingOverrides merges into the payload without mutating it", () => {
  const payload = { model: "m", temperature: 0.5, max_completion_tokens: 10 };
  assert.deepEqual(applySamplingOverrides(payload, { presence_penalty: 1, temperature: 1 }), {
    model: "m",
    temperature: 1,
    max_completion_tokens: 10,
    presence_penalty: 1,
  });
  assert.equal(payload.temperature, 0.5);
  assert.equal(applySamplingOverrides("x", { presence_penalty: 1 }), "x");
});
