import test from "node:test";
import assert from "node:assert/strict";
import {
  calibrationError,
  extractResponseSelfReportedConfidence,
  resolveResponseCalibrationConfidence,
} from "../src/evaluation/calibration";

void test("extractResponseSelfReportedConfidence reads the final response confidence", () => {
  const response = ["Explanation: grounded answer.", "Exact Answer: alpha", "Confidence: 72%"].join(
    "\n",
  );

  assert.equal(extractResponseSelfReportedConfidence(response), 72);
});

void test("resolveResponseCalibrationConfidence defaults missing response confidence to 100", () => {
  const response = ["Explanation: grounded answer.", "Exact Answer: alpha"].join("\n");

  assert.equal(extractResponseSelfReportedConfidence(response), null);
  assert.equal(resolveResponseCalibrationConfidence(response), 100);
});

void test("calibrationError includes the final partial bin", () => {
  const confidences = Array.from({ length: 150 }, () => 100);
  const correctness = Array.from({ length: 150 }, (_, index) => index < 100);

  assert.equal(calibrationError(confidences, correctness, 100), 57.735026918962575);
});
