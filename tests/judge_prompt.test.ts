import assert from "node:assert/strict";
import test from "node:test";

import { createJudgePrompt } from "../src/evaluation/judge_prompt";

void test("gold-answer judge accepts any alternative in a JSON answer array", () => {
  const prompt = createJudgePrompt({
    mode: "gold-answer",
    question: "What is the answer?",
    response: "Exact Answer: Alpha",
    correctAnswer: '["Alpha","A"]',
  });

  assert.match(prompt, /JSON array of acceptable alternatives/);
  assert.match(prompt, /matching any one alternative is correct/);
  assert.match(prompt, /Correct answer: \["Alpha","A"\]/);
});

void test("reference-free judge does not mention acceptable gold alternatives", () => {
  const prompt = createJudgePrompt({
    mode: "reference-free",
    question: "What is the answer?",
    response: "Exact Answer: Alpha",
  });

  assert.doesNotMatch(prompt, /acceptable alternatives/);
  assert.match(prompt, /reference-free mode/);
});
