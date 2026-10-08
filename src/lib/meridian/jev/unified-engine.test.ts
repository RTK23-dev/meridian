import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterJevClient } from "./client.ts";
import { evaluatePolicy, DEFAULT_POLICY_THRESHOLDS } from "./policy.ts";
import { jevRegistry } from "./registry.ts";
import { computeBrierScore, computeLogLoss, assessReliability } from "./calibration.ts";
import type { JevAnswer, JevDecisionRequest } from "./types.ts";

test("OpenRouterJevClient abstains when required evidence is missing", async () => {
  const client = new OpenRouterJevClient();
  const question = jevRegistry.get("safety.claim_compliance.v1");
  assert.ok(question);

  // Request with state missing the required evidence
  const req: JevDecisionRequest = {
    organizationId: "org-1",
    brandId: "brand-1",
    state: {
      description: "Test state with no evidence",
      availableEvidence: [],
    },
    questions: {
      [question.id]: question,
    },
  };

  const response = await client.decide(req);
  assert.ok(response.answers[question.id]);
  const answer = response.answers[question.id]!;
  assert.equal(answer.status, "abstain_insufficient_evidence");
  assert.equal(answer.confidence, undefined);
  assert.equal((answer as any).answer, undefined);
  assert.match(answer.abstainReason!, /required evidence/i);
});

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

test("OpenRouterJevClient parses native choice, noul, and score responses correctly", async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.match(String(url), /\/decisions$/);
    const body = JSON.parse(String(init?.body || "{}"));
    assert.equal(body.model, "typesafe/jev-1.13");

    return new Response(
      JSON.stringify({
        answers: {
          q_noul: {
            type: "noul",
            noul: 0.88,
          },
          q_choice: {
            type: "choice",
            choice: "curiosity_gap",
            probabilities: { curiosity_gap: 0.75, problem_solution: 0.25 },
            confidence: 0.92,
          },
          q_score: {
            type: "score",
            score: 4.5,
            probabilities: { "4": 0.3, "5": 0.7 },
            confidence: 0.85,
            legend: { "1": "poor", "5": "exceptional" },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const client = new OpenRouterJevClient({
    apiKey: "test-openrouter-key",
    fetchImpl: fakeFetch,
  });

  const response = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: {
      description: "Evaluation with evidence",
      availableEvidence: ["metadata", "transcript"],
    },
    questions: {
      q_noul: {
        id: "q_noul",
        version: "v1",
        type: "noul",
        instructions: "Is this authentic?",
        criteria: { true: "yes", false: "no" },
        evidenceRequirements: ["metadata"],
      },
      q_choice: {
        id: "q_choice",
        version: "v1",
        type: "choice",
        instructions: "Which hook mechanism?",
        criteria: { curiosity_gap: "Curiosity", problem_solution: "Problem" },
        evidenceRequirements: ["transcript"],
      },
      q_score: {
        id: "q_score",
        version: "v1",
        type: "score",
        instructions: "Visual craft level",
        criteria: ["1", "2", "3", "4", "5"],
        evidenceRequirements: [],
      },
    },
  });

  const ansNoul = response.answers.q_noul;
  assert.ok(ansNoul);
  assert.equal(ansNoul.type, "noul");
  assert.equal(ansNoul.noul, 0.88);
  assert.equal(ansNoul.probability, 0.88);
  assert.equal(ansNoul.answer, true);
  assert.equal(ansNoul.confidence, undefined); // noul confidence must remain undefined

  const ansChoice = response.answers.q_choice;
  assert.ok(ansChoice);
  assert.equal(ansChoice.type, "choice");
  assert.equal(ansChoice.choice, "curiosity_gap");
  assert.equal(ansChoice.confidence, 0.92);
  assert.equal(ansChoice.probabilities?.curiosity_gap, 0.75);

  const ansScore = response.answers.q_score;
  assert.ok(ansScore);
  assert.equal(ansScore.type, "score");
  assert.equal(ansScore.score, 4.5);
  assert.equal(ansScore.confidence, 0.85);
  assert.equal(ansScore.legend?.["5"], "exceptional");
});

test("OpenRouterJevClient abstains without generic chat fallback when API errors", async () => {
  let callCount = 0;
  const errorFetch: typeof fetch = async (url) => {
    callCount++;
    assert.match(String(url), /\/decisions$/);
    // Return 500 error
    return new Response("Internal Server Error", { status: 500 });
  };

  const client = new OpenRouterJevClient({
    apiKey: "test-openrouter-key",
    fetchImpl: errorFetch,
  });

  const response = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "Error state" },
    questions: {
      q_fail: {
        id: "q_fail",
        version: "v1",
        type: "noul",
        instructions: "Test failure",
        criteria: { true: "y", false: "n" },
        evidenceRequirements: [],
      },
    },
  });

  assert.equal(callCount, 1); // No secondary fallback call to /chat/completions
  const ans = response.answers.q_fail;
  assert.ok(ans);
  assert.equal(ans.status, "provider_error");
  assert.match(ans.abstainReason!, /Decisions API returned status 500/);
});
