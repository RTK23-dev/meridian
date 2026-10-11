import assert from "node:assert/strict";
import test from "node:test";
import type { JevDecisionRequest, JevDecisionResponse, JevProvider, JevProviderHealth, JevProviderRouter } from "../jev/types.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { OpenAiDecisionsEngine } from "./openai-engine.ts";
import { evaluateDecisionPolicy, CREATIVE_QA_POLICY } from "./policy.ts";
import { CONTRACT_CHOICE, CONTRACT_EXPECTED, CONTRACT_KEYS, CONTRACT_PREDICATE, CONTRACT_SCORE, contractPngBytes, contractRequest } from "./contract-fixtures.ts";
import type { DecisionRequest, DecisionResult } from "./types.ts";

// Both engines run the same provider-neutral fixtures. The JEV side uses a router stub shaped like the existing JEV
// router's output. The OpenAI side uses a fetch stub shaped like the documented Decisions response.

type RouterCall = { request: JevDecisionRequest };

function jevRouterStub(calls: RouterCall[], answers?: Record<string, unknown>): JevProviderRouter {
  const provider: JevProvider = {
    id: "typesafe_direct",
    capabilities: () => ({ primitives: ["noul", "choice", "score"], batchDecisions: true, explanation: false }),
    health: async (): Promise<JevProviderHealth> => ({ status: "READY" }),
    decide: async () => ({ runId: "run", model: "typesafe/jev-1.13", provider: "typesafe_direct", inputHash: "h", cached: false, latencyMs: 1, answers: {} }),
  };
  return {
    getProvider: () => provider,
    health: async () => ({ typesafe_direct: { status: "READY" } }),
    decide: async (request: JevDecisionRequest): Promise<JevDecisionResponse> => {
      calls.push({ request });
      const out: JevDecisionResponse["answers"] = {};
      for (const [key, spec] of Object.entries(request.questions)) {
        const base = { questionId: spec.id, questionVersion: spec.version, type: spec.type, model: "typesafe/jev-1.13", provider: "typesafe_direct", evidenceRefs: [], evaluatedAt: new Date().toISOString() };
        if (answers?.[key]) {
          out[key] = answers[key] as JevDecisionResponse["answers"][string];
          continue;
        }
        if (spec.type === "noul") out[key] = { ...base, status: "answered", noul: CONTRACT_EXPECTED.predicateProbability, probability: CONTRACT_EXPECTED.predicateProbability, answer: CONTRACT_EXPECTED.predicateProbability } as never;
        else if (spec.type === "choice") out[key] = { ...base, status: "answered", choice: CONTRACT_EXPECTED.choiceValue, answer: CONTRACT_EXPECTED.choiceValue, confidence: CONTRACT_EXPECTED.choiceConfidence, probabilities: { organic_catalyst: 0.8, bolted_on_cta: 0.2 } } as never;
        else out[key] = { ...base, status: "answered", score: CONTRACT_EXPECTED.scoreIndex, answer: CONTRACT_EXPECTED.scoreIndex, confidence: 0.7 } as never;
      }
      return { runId: "run-jev", model: "typesafe/jev-1.13", provider: "typesafe_direct", inputHash: "h", cached: false, latencyMs: 2, answers: out };
    },
  };
}

function echoOpenAi(calls: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const answers = (body.questions as Array<Record<string, unknown>>).map((q) => {
      if (q.type === "predicate") return { type: "predicate", name: q.name, probability: CONTRACT_EXPECTED.predicateProbability };
      if (q.type === "choice") return { type: "choice", name: q.name, choice: CONTRACT_EXPECTED.choiceValue, probabilities: [{ value: CONTRACT_EXPECTED.choiceValue, probability: 0.8 }], confidence: CONTRACT_EXPECTED.choiceConfidence };
      return { type: "score", name: q.name, score: CONTRACT_EXPECTED.scoreIndex, probabilities: [{ value: 3, label: "4", probability: 0.6 }], confidence: 0.7 };
    });
    return new Response(JSON.stringify({ model: "gpt-6-luna", answers }), { status: 200 });
  }) as typeof fetch;
}

const noSleep = async () => {};

async function bothEngines(request: DecisionRequest): Promise<{ jev: DecisionResult; openai: DecisionResult }> {
  const jev = await new JevDecisionEngine(jevRouterStub([])).decide(request);
  const openai = await new OpenAiDecisionsEngine({
    config: { apiKey: "sk-contract-test-key-0001", model: "gpt-6-luna", maxRetries: 0 },
    fetchImpl: echoOpenAi([]),
    sleep: noSleep,
  }).decide(request);
  return { jev, openai };
}

test("both engines answer the same three question kinds with the same normalized semantics", async () => {
  const { jev, openai } = await bothEngines(contractRequest());
  for (const engine of [jev, openai]) {
    assert.equal(engine.answers[CONTRACT_KEYS.predicate].status, "answered");
    assert.equal(engine.answers[CONTRACT_KEYS.predicate].semantics, "probability");
    assert.equal(engine.answers[CONTRACT_KEYS.choice].semantics, "categorical");
    assert.equal(engine.answers[CONTRACT_KEYS.score].semantics, "ordered_score");
    for (const answer of Object.values(engine.answers)) {
      assert.equal(answer.calibrationStatus, "uncalibrated", "neither engine's output is presented as calibrated");
    }
  }
  assert.equal(jev.answers[CONTRACT_KEYS.predicate].probability, openai.answers[CONTRACT_KEYS.predicate].probability);
  assert.equal(jev.answers[CONTRACT_KEYS.choice].choice, openai.answers[CONTRACT_KEYS.choice].choice);
  assert.equal(jev.answers[CONTRACT_KEYS.score].score, openai.answers[CONTRACT_KEYS.score].score);
});

test("both engines produce the same policy outcome from the same fixture values", async () => {
  const policy = { ...CREATIVE_QA_POLICY, approveChoices: [CONTRACT_EXPECTED.choiceValue], approveMinScore: 3 };
  const { jev, openai } = await bothEngines(contractRequest());
  const expected = [CONTRACT_PREDICATE.id, CONTRACT_CHOICE.id, CONTRACT_SCORE.id];
  const a = evaluateDecisionPolicy(jev.answers, policy, expected);
  const b = evaluateDecisionPolicy(openai.answers, policy, expected);
  assert.equal(a.outcome, b.outcome);
  assert.deepEqual(a.votes.map((vote) => vote.outcome), b.votes.map((vote) => vote.outcome));
});

test("an image-required decision is refused by JEV, which is text-only, and never reaches the router", async () => {
  const calls: RouterCall[] = [];
  const result = await new JevDecisionEngine(jevRouterStub(calls)).decide(
    contractRequest({ images: [{ bytes: contractPngBytes() }], imagePolicy: "required" }),
  );
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "unsupported_input");
  for (const answer of Object.values(result.answers)) assert.equal(answer.status, "unsupported");
});

test("optional images are not forwarded to JEV, and the omission is recorded", async () => {
  const calls: RouterCall[] = [];
  const result = await new JevDecisionEngine(jevRouterStub(calls)).decide(
    contractRequest({ images: [{ bytes: contractPngBytes() }, { bytes: contractPngBytes() }], imagePolicy: "optional" }),
  );
  assert.equal(calls.length, 1);
  assert.equal("images" in calls[0].request, false, "no image bytes reach the JEV transport");
  assert.equal(result.imagesOmitted, 2);
  assert.equal(result.inputModality, "text");
});

test("a JEV answer that was refused is not converted into an approval", async () => {
  const refused = {
    questionId: CONTRACT_PREDICATE.id,
    questionVersion: "1.0.0",
    type: "noul",
    model: "typesafe/jev-1.13",
    provider: "typesafe_direct",
    status: "refused",
    evidenceRefs: [],
    abstainReason: "refused",
    evaluatedAt: new Date().toISOString(),
  };
  const result = await new JevDecisionEngine(jevRouterStub([], { positioning: refused })).decide(contractRequest());
  const evaluation = evaluateDecisionPolicy(result.answers, CREATIVE_QA_POLICY, [CONTRACT_PREDICATE.id]);
  assert.notEqual(evaluation.outcome, "AUTO_APPROVE");
});

test("JEV declares text-only capabilities and the same question kinds as the other engine", () => {
  const capabilities = new JevDecisionEngine(jevRouterStub([])).capabilities();
  assert.deepEqual(capabilities.inputModalities, ["text"]);
  assert.equal(capabilities.maxImages, 0);
  assert.deepEqual(capabilities.questionKinds, ["predicate", "choice", "score"]);
});
