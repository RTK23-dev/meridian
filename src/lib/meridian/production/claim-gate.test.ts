import { unselectedOpenRouterEngine } from "../../../test-support/lib/meridian/testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest } from "../decisions/types.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { judgeCopy, type JudgeCopyInput } from "./assess.ts";

type Answerer = (request: DecisionRequest) => Record<string, JevAnswer>;

/** An engine that answers every question it is asked, with the given probability and calibration, and counts its calls. */
function answeringEngine(id: DecisionEngineId, answer: Answerer, calls: DecisionEngineId[] = []): DecisionEngine {
  return {
    id,
    adapterVersion: "test.v1",
    capabilities: () => ({
      engineId: id,
      questionKinds: [],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      calls.push(id);
      return {
        runId: `run-${id}`,
        model: "test-model",
        provider: "test",
        inputHash: "test-hash",
        cached: false,
        latencyMs: 1,
        answers: answer(request),
        engineId: id,
        adapterVersion: "test.v1",
        requestedModel: "test-model",
        returnedModel: "test-model",
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
      };
    },
  };
}

/** An engine that must never be called. A deterministic rule has to reject before any engine is asked. */
function forbiddenEngine(id: DecisionEngineId, calls: DecisionEngineId[]): DecisionEngine {
  return {
    ...answeringEngine(id, () => ({}), calls),
    decide: async () => {
      calls.push(id);
      throw new Error("an engine must not be called for a deterministic rejection");
    },
  };
}

function answered(spec: JevQuestionSpec, probability: number, calibrationStatus: "calibrated" | "uncalibrated"): JevAnswer {
  return {
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "test-model",
    provider: "test",
    status: "answered",
    noul: probability,
    probability,
    answer: probability >= 0.5,
    confidence: 0.9,
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
    semantics: "probability",
    calibrationStatus,
  };
}

/** One answer per question the request asks, each with the same probability and calibration. */
const answerEvery =
  (probability: number, calibrationStatus: "calibrated" | "uncalibrated"): Answerer =>
  (request) =>
    Object.fromEntries(Object.entries(request.questions).map(([key, spec]) => [key, answered(spec, probability, calibrationStatus)]));

const notConfigured: Answerer = (request) =>
  abstainAll(request, {
    status: "not_configured",
    reason: "No decision engine is configured for this workspace.",
    model: "none",
    provider: "test",
  });

const CLEAN_COPY = "Acme Cleanser lifts grease in one wipe.";

function input(text: string, prohibitedClaims = "guaranteed", engines?: DecisionEngineRegistry): JudgeCopyInput {
  return {
    copy: {
      text,
      productName: "Acme Cleanser",
      allowedClaims: "",
      prohibitedClaims,
      requiredDisclaimers: "",
      wordsToAvoid: "",
      hook: "Watch this",
      cta: "Buy now",
    },
    organizationId: "org-claims",
    brandId: "brand-claims",
    subject: { type: "creative", id: "creative-claims" },
    selection: { engineId: "jev", source: "workspace" },
    engines,
  };
}

test("a copy claim with no engine configured is reported not judged, and is never passed", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", notConfigured, calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy({ ...input(CLEAN_COPY, "guaranteed", engines), selection: { engineId: "jev", source: "default" } });
  assert.equal(judged.claim.judgment, "not_judged");
  assert.notEqual(judged.claim.judgment, "passed");
  assert.match(judged.claim.reason, /^Claim not judged:/);
  assert.equal(judged.claim.gate?.action, "HUMAN_REVIEW");
  assert.notEqual(judged.decision.decision, "AUTO_APPROVE", "a copy whose claim was not judged is not approved");
  assert.deepEqual(calls, ["jev"], "only the selected engine was asked");
});

test("an uncalibrated engine answer on a claim routes to review and does not pass", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", answerEvery(0.99, "uncalibrated"), calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy(input(CLEAN_COPY, "guaranteed", engines));
  assert.equal(judged.claim.judgment, "review", "an uncalibrated pass is judged, but it is routed to review");
  assert.equal(judged.claim.gate?.action, "HUMAN_REVIEW");
  assert.equal(judged.decision.decision, "HUMAN_REVIEW");
  assert.notEqual(judged.claim.judgment, "passed");
});

test("a calibrated passing answer passes the claim, and the copy still waits for its own QA", async () => {
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", answerEvery(0.97, "calibrated")),
    "openai-decisions": forbiddenEngine("openai-decisions", []),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy(input(CLEAN_COPY, "guaranteed", engines));
  assert.equal(judged.claim.judgment, "passed");
  assert.equal(judged.claim.gate?.action, "AUTO_APPROVE");
  // The copy QA is uncalibrated, so the claim pass is a ceiling, not an approval of the copy.
  assert.equal(judged.decision.decision, "HUMAN_REVIEW");
});

test("a calibrated engine answer that violates the claim rejects the copy as an unsupported claim", async () => {
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", answerEvery(0.2, "calibrated")),
    "openai-decisions": forbiddenEngine("openai-decisions", []),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy(input(CLEAN_COPY, "guaranteed", engines));
  assert.equal(judged.claim.judgment, "rejected");
  assert.equal(judged.decision.decision, "REJECT");
  assert.equal(judged.reasonCode, "unsupported_claim");
});

test("a deterministic claim rule still rejects with no engine call, whatever the engine would say", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: forbiddenEngine("jev", calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy(input("Acme Cleanser is a guaranteed fix.", "guaranteed", engines));
  assert.equal(judged.decision.decision, "REJECT");
  assert.equal(judged.reasonCode, "prohibited_claim");
  assert.equal(judged.claim.judgment, "rejected");
  assert.equal(judged.claim.gate?.engineCalled, false);
  assert.deepEqual(calls, [], "no engine was asked");
});

test("a check with no brand asks no claim question, so its claim is not judged and nothing is passed", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: forbiddenEngine("jev", calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy({ ...input(CLEAN_COPY, "guaranteed", engines), brandId: null });
  assert.equal(judged.claim.judgment, "not_judged");
  assert.equal(judged.claim.gate, null);
  assert.notEqual(judged.decision.decision, "AUTO_APPROVE");
  assert.deepEqual(calls, [], "no engine was asked");
});

test("a brand with no stored prohibited claims gives the claim question no evidence, so the claim is not judged", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", answerEvery(0.99, "calibrated"), calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy(input(CLEAN_COPY, "", engines));
  assert.equal(judged.claim.judgment, "not_judged", "a question that lacks its brand evidence abstains, and abstaining is not a pass");
  assert.notEqual(judged.claim.judgment, "passed");
  assert.notEqual(judged.decision.decision, "AUTO_APPROVE");
});

test("stored allowed claims are enough for the claim question when no prohibited list is stored", async () => {
  const calls: DecisionEngineId[] = [];
  const engines: DecisionEngineRegistry = {
    jev: answeringEngine("jev", answerEvery(0.97, "calibrated"), calls),
    "openai-decisions": forbiddenEngine("openai-decisions", calls),
    "openrouter-decisions": unselectedOpenRouterEngine(),
  };
  const judged = await judgeCopy({ ...input(CLEAN_COPY, "", engines), copy: { ...input(CLEAN_COPY, "", engines).copy, allowedClaims: "lifts grease" } });
  assert.equal(judged.claim.judgment, "passed");
  assert.deepEqual(calls, ["jev"]);
});
