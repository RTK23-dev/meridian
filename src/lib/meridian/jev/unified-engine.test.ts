import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, DEFAULT_POLICY_THRESHOLDS } from "./policy.ts";
import { computeBrierScore, computeLogLoss, assessReliability } from "./calibration.ts";
import type { JevAnswer } from "./types.ts";

test("evaluatePolicy rejects immediately on policy violation", () => {
  const answers: Record<string, JevAnswer> = {
    safe_prohibited_content: {
      questionId: "safe_prohibited_content",
      questionVersion: "v1",
      model: "test-model",
      provider: "test-provider",
      status: "answered",
      answer: false, // failed safety
      confidence: 0.95,
      evidenceRefs: [],
      evaluatedAt: new Date().toISOString(),
    },
  };

  const evalResult = evaluatePolicy(answers, DEFAULT_POLICY_THRESHOLDS);
  assert.equal(evalResult.decision, "REJECT");
  assert.ok(evalResult.violationCount > 0);
});

test("evaluatePolicy forbids auto-approval on uncertain or missing evidence", () => {
  const answers: Record<string, JevAnswer> = {
    org_hook_intent: {
      questionId: "org_hook_intent",
      questionVersion: "v1",
      model: "test-model",
      provider: "test-provider",
      status: "abstain_insufficient_evidence",
      evidenceRefs: [],
      evaluatedAt: new Date().toISOString(),
      abstainReason: "No video transcript available",
    },
  };

  const evalResult = evaluatePolicy(answers, DEFAULT_POLICY_THRESHOLDS);
  assert.equal(evalResult.decision, "HUMAN_REVIEW");
  assert.notEqual(evalResult.decision, "AUTO_APPROVE");
});

test("evaluatePolicy auto-approves when all criteria pass with high probability and confidence", () => {
  const answers: Record<string, JevAnswer> = {
    q1: {
      questionId: "q1",
      questionVersion: "v1",
      model: "test-model",
      provider: "test-provider",
      status: "answered",
      answer: true,
      probability: 0.95,
      confidence: 0.90,
      evidenceRefs: [],
      evaluatedAt: new Date().toISOString(),
    },
    q2: {
      questionId: "q2",
      questionVersion: "v1",
      model: "test-model",
      provider: "test-provider",
      status: "answered",
      answer: true,
      probability: 0.92,
      confidence: 0.88,
      evidenceRefs: [],
      evaluatedAt: new Date().toISOString(),
    },
  };

  const evalResult = evaluatePolicy(answers, DEFAULT_POLICY_THRESHOLDS);
  assert.equal(evalResult.decision, "AUTO_APPROVE");
});

test("calibration metrics compute correct Brier score and log loss", () => {
  const samples = [
    { probability: 0.9, outcome: 1 },
    { probability: 0.8, outcome: 1 },
    { probability: 0.1, outcome: 0 },
    { probability: 0.2, outcome: 0 },
  ];

  const brier = computeBrierScore(samples);
  assert.ok(brier < 0.05);

  const logLoss = computeLogLoss(samples);
  assert.ok(logLoss < 0.3);

  const reliability = assessReliability(samples);
  assert.ok(reliability.calibrationGrade === "well_calibrated" || reliability.calibrationGrade === "moderate");
});

