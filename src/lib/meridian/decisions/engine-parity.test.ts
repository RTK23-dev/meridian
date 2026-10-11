/**
 * Contract tests for the two decision engines. The same case runs against the TypeSafe JEV engine (the real transport, with an
 * injected credential and fetch) and against the OpenAI Decisions engine (the real adapter, with an injected fetch). No live
 * request is made. Keys come from credentials/fixtures.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fixedLookup } from "../credentials/fixtures.ts";
import { JevRouter, TypeSafeDirectJevProvider } from "../jev/router.ts";
import type { JevProviderRouter, JevQuestionSpec } from "../jev/types.ts";
import { evaluateDecisionPolicy, evaluateQuestionPolicies, policyForQuestion, type DecisionPolicy } from "./policy.ts";
import { runEngineGate, type GateQuestion } from "./gate.ts";
import { decideWithActiveEngine } from "./dispatcher.ts";
import { JevDecisionEngine } from "./jev-engine.ts";
import { OPENAI_DECISIONS_MAX_IMAGES, OpenAiDecisionsEngine } from "./openai-engine.ts";
import { CONTRACT_CHOICE, CONTRACT_EXPECTED, CONTRACT_KEYS, CONTRACT_PREDICATE, contractPngBytes, contractRequest } from "./contract-fixtures.ts";
import type { DecisionRequest, DecisionResult } from "./types.ts";

type Mode = "ok" | "http_error" | "timeout";

/** The predicate answer in each engine's wire form, for the question named `name` (OpenAI) or keyed `key` (JEV). */
function answerFor(type: string): Record<string, unknown> {
  if (type === "predicate" || type === "noul") return { probability: CONTRACT_EXPECTED.predicateProbability, noul: CONTRACT_EXPECTED.predicateProbability };
  if (type === "choice") return { choice: CONTRACT_EXPECTED.choiceValue, confidence: CONTRACT_EXPECTED.choiceConfidence, probabilities: { [CONTRACT_EXPECTED.choiceValue]: 0.8 } };
  return { score: CONTRACT_EXPECTED.scoreIndex, confidence: 0.7 };
}

function openAiFetch(mode: Mode) {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (mode === "timeout") throw Object.assign(new Error("The request timed out."), { name: "TimeoutError" });
    if (mode === "http_error") return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 500 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const answers = (body.questions as Array<{ name: string; type: string }>).map((question) => ({ type: question.type, name: question.name, ...answerFor(question.type) }));
    return new Response(JSON.stringify({ model: "gpt-6-luna", answers }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, bodies, calls: () => calls };
}

function jevFetch(mode: Mode) {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (mode === "http_error") return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 500 });
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
    bodies.push(body as unknown as Record<string, unknown>);
    const answers: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(body.questions)) answers[key] = answerFor(spec.type);
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, bodies, calls: () => calls };
}

function buildEngines(options: { jev?: Mode; openai?: Mode } = {}) {
  const jev = jevFetch(options.jev ?? "ok");
  const openai = openAiFetch(options.openai ?? "ok");
  const router: JevProviderRouter = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({
      lookup: fixedLookup("typesafe-fixture-key-0001"),
      baseUrl: "https://typesafe.fixture.test/v1",
      fetchImpl: jev.fetchImpl,
    }),
  });
  const jevEngine = new JevDecisionEngine(router);
  const openaiEngine = new OpenAiDecisionsEngine({
    config: { apiKey: "sk-fixture-openai-key-0001", model: "gpt-6-luna", maxRetries: 0 },
    fetchImpl: openai.fetchImpl,
    sleep: async () => {},
  });
  return { jev, openai, registry: { jev: jevEngine, "openai-decisions": openaiEngine } as const, jevEngine, openaiEngine };
}

const withPolicy = (spec: JevQuestionSpec, policyMapping: JevQuestionSpec["policyMapping"]): JevQuestionSpec => ({ ...spec, policyMapping });
const REVIEW_ON_UNRESOLVED = withPolicy(CONTRACT_PREDICATE, { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6, unresolvedOutcome: "HUMAN_REVIEW" });
const REJECT_ON_UNRESOLVED = withPolicy(CONTRACT_PREDICATE, { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6, unresolvedOutcome: "REJECT" });

const gateQuestions = (spec: JevQuestionSpec): GateQuestion[] => [{ key: "positioning", spec, needsImage: false, evidenceScope: ["copy"] }];
const copyEvidence = [{ kind: "text" as const, name: "copy", source: "fixture", content: { copy: "A kitchen demo." } }];

function unknownKind(): JevQuestionSpec {
  return { ...CONTRACT_PREDICATE, id: "brand.unknown_kind.v1", type: "rank" as unknown as JevQuestionSpec["type"] };
}

function pngImages(count: number) {
  return Array.from({ length: count }, (_, index) => ({ bytes: contractPngBytes(), label: `Frame ${index}`, evidenceRef: { kind: "frame", artifactId: `frame-${index}` } }));
}

test("images: OpenAI sends images up to its maximum, and refuses one more before any request", async () => {
  const { openai, openaiEngine } = buildEngines();
  const sent = await openaiEngine.decide(contractRequest({ images: pngImages(2), imagePolicy: "required" }));
  assert.equal(sent.failure, undefined);
  assert.equal(sent.imageCount, 2);
  assert.equal(JSON.stringify(openai.bodies[0]).match(/input_image/g)?.length, 2, "both images are sent as image parts");

  const atMaximum = await openaiEngine.decide(contractRequest({ images: pngImages(OPENAI_DECISIONS_MAX_IMAGES), imagePolicy: "required" }));
  assert.equal(atMaximum.failure, undefined, `${OPENAI_DECISIONS_MAX_IMAGES} images are accepted`);
  assert.equal(openai.calls(), 2);

  const over = buildEngines();
  const refused = await over.openaiEngine.decide(contractRequest({ images: pngImages(OPENAI_DECISIONS_MAX_IMAGES + 1), imagePolicy: "required" }));
  assert.equal(refused.failure?.kind, "unsupported_input");
  assert.equal(over.openai.calls(), 0, "no request is made for an over-limit image set");
  for (const answer of Object.values(refused.answers)) assert.equal(answer.status, "unsupported");
});

test("images: JEV, which is text-only, refuses required images with zero transport calls and never sends optional images", async () => {
  const required = buildEngines();
  const refused = await required.jevEngine.decide(contractRequest({ images: pngImages(2), imagePolicy: "required" }));
  assert.equal(refused.failure?.kind, "unsupported_input");
  assert.equal(required.jev.calls(), 0);
  for (const answer of Object.values(refused.answers)) assert.equal(answer.status, "unsupported");

  const optional = buildEngines();
  const sent = await optional.jevEngine.decide(contractRequest({ images: pngImages(2), imagePolicy: "optional" }));
  assert.equal(optional.jev.calls(), 1);
  assert.equal(sent.imagesOmitted, 2, "the omission is recorded");
  assert.equal(sent.inputModality, "text");
  assert.equal(JSON.stringify(optional.jev.bodies[0]).includes("data:image"), false, "no image bytes reach the text-only route");
});

test("unsupported question kinds: both engines refuse the unknown kind, answer the valid question, and send only the valid one", async () => {
  const request: DecisionRequest = contractRequest({ questions: { positioning: CONTRACT_PREDICATE, odd: unknownKind() } });
  const { jev, openai, jevEngine, openaiEngine } = buildEngines();
  const fromJev = await jevEngine.decide(request);
  const fromOpenAi = await openaiEngine.decide(request);
  for (const result of [fromJev, fromOpenAi]) {
    assert.equal(result.answers.odd?.status, "unsupported");
    assert.equal(result.answers.positioning?.status, "answered");
  }
  assert.deepEqual(Object.keys(jev.bodies[0]!.questions as object), ["positioning"], "JEV never receives the unknown kind");
  const wire = openai.bodies[0]!.questions as Array<{ name: string }>;
  assert.equal(wire.length, 1, "OpenAI never receives the unknown kind");
});

test("unsupported question kinds: a request holding only the unknown kind sends nothing to either engine", async () => {
  const request: DecisionRequest = contractRequest({ questions: { odd: unknownKind() } });
  const { jev, openai, jevEngine, openaiEngine } = buildEngines();
  const fromJev = await jevEngine.decide(request);
  const fromOpenAi = await openaiEngine.decide(request);
  assert.equal(fromJev.answers.odd?.status, "unsupported");
  assert.equal(fromOpenAi.answers.odd?.status, "unsupported");
  assert.equal(jev.calls(), 0);
  assert.equal(openai.calls(), 0);
});

test("provider HTTP error: both engines answer every question provider_error, and the gate does not approve", async () => {
  for (const selected of ["jev", "openai-decisions"] as const) {
    const { registry, jev, openai } = buildEngines({ jev: "http_error", openai: "http_error" });
    const selectedCalls = () => (selected === "jev" ? jev.calls() : openai.calls());
    const result = await runEngineGate({
      organizationId: "org-parity",
      brandId: "brand-parity",
      gate: "parity",
      subject: { type: "creative", id: "creative-parity" },
      description: "Parity fixture.",
      questions: gateQuestions(REVIEW_ON_UNRESOLVED),
      evidence: copyEvidence,
      selection: { engineId: selected, source: "workspace" },
      engines: registry,
    });
    assert.equal(result.answers.positioning?.status, "provider_error", `${selected}: provider_error`);
    assert.notEqual(result.action, "AUTO_APPROVE", `${selected}: an error never approves`);
    assert.equal(result.action, "HUMAN_REVIEW", `${selected}: the default unresolved outcome is review`);
    assert.equal(selectedCalls(), 1, `${selected}: the selected engine was called once`);
  }
});

test("provider timeout: both engines answer provider_error; OpenAI names the timeout, JEV folds it into provider_unavailable", async () => {
  const openAiSide = buildEngines({ openai: "timeout" });
  const fromOpenAi = await openAiSide.openaiEngine.decide(contractRequest());
  assert.equal(fromOpenAi.failure?.kind, "timeout");
  for (const answer of Object.values(fromOpenAi.answers)) assert.equal(answer.status, "provider_error");

  // The JEV transport has no request timeout of its own. A timed-out fetch is caught and reported as provider_error.
  const jevSide = buildEngines({ jev: "timeout" });
  const fromJev = await jevSide.jevEngine.decide(contractRequest());
  for (const answer of Object.values(fromJev.answers)) assert.equal(answer.status, "provider_error");
  assert.equal(fromJev.failure?.kind, "provider_unavailable");
});

test("policy outcomes: the same failure gives the same policy outcome from both engines, and never an approval", async () => {
  const policies: Array<{ name: string; spec: JevQuestionSpec; expected: "HUMAN_REVIEW" | "REJECT" }> = [
    { name: "review on unresolved", spec: REVIEW_ON_UNRESOLVED, expected: "HUMAN_REVIEW" },
    { name: "reject on unresolved", spec: REJECT_ON_UNRESOLVED, expected: "REJECT" },
  ];
  for (const entry of policies) {
    for (const mode of ["http_error", "timeout"] as const) {
      const outcomes: string[] = [];
      for (const selected of ["jev", "openai-decisions"] as const) {
        const { registry } = buildEngines({ jev: mode, openai: mode });
        const result = await runEngineGate({
          organizationId: "org-parity",
          brandId: "brand-parity",
          gate: "parity",
          subject: { type: "creative", id: "creative-parity" },
          description: "Parity fixture.",
          questions: gateQuestions(entry.spec),
          evidence: copyEvidence,
          selection: { engineId: selected, source: "workspace" },
          engines: registry,
        });
        outcomes.push(result.action);
        assert.notEqual(result.action, "AUTO_APPROVE");
      }
      assert.deepEqual(outcomes, [entry.expected, entry.expected], `${entry.name} (${mode}): both engines give ${entry.expected}`);
    }
  }
});

test("policy outcomes: an answered value from each engine is evaluated by the same policy to the same outcome", async () => {
  const policy: DecisionPolicy = { version: "parity.v1", predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6, unresolvedOutcome: "HUMAN_REVIEW" };
  const { registry } = buildEngines();
  const request = contractRequest();
  const fromJev = await registry.jev.decide(request);
  const fromOpenAi = await registry["openai-decisions"].decide(request);
  const expected = [CONTRACT_KEYS.predicate, CONTRACT_KEYS.choice, CONTRACT_KEYS.score].map((key) => (request.questions[key] as JevQuestionSpec).id);
  const a = evaluateDecisionPolicy(fromJev.answers, policy, expected);
  const b = evaluateDecisionPolicy(fromOpenAi.answers, policy, expected);
  assert.equal(a.outcome, b.outcome);
  assert.notEqual(a.outcome, "AUTO_APPROVE", "an uncalibrated value does not approve");
  assert.deepEqual(a.votes.map((vote) => vote.outcome), b.votes.map((vote) => vote.outcome));
});

test("policy outcomes: a question with no policy mapping is review on either engine, however confident its answer", async () => {
  const unmapped = CONTRACT_CHOICE;
  assert.equal(policyForQuestion(unmapped), null);
  const { registry } = buildEngines();
  for (const engine of [registry.jev, registry["openai-decisions"]]) {
    const result = await engine.decide(contractRequest({ questions: { naturalness: unmapped } }));
    const evaluation = evaluateQuestionPolicies(result.answers, [{ questionId: unmapped.id, policy: policyForQuestion(unmapped) }]);
    assert.equal(evaluation.outcome, "HUMAN_REVIEW");
  }
});

test("no fallback: with OpenAI selected and failing, the JEV transport receives zero requests", async () => {
  const { jev, openai, registry } = buildEngines({ openai: "http_error", jev: "ok" });
  const result = await runEngineGate({
    organizationId: "org-parity",
    brandId: "brand-parity",
    gate: "parity",
    subject: { type: "creative", id: "creative-parity" },
    description: "Parity fixture.",
    questions: gateQuestions(REVIEW_ON_UNRESOLVED),
    evidence: copyEvidence,
    selection: { engineId: "openai-decisions", source: "workspace" },
    engines: registry,
  });
  assert.equal(openai.calls(), 1);
  assert.equal(jev.calls(), 0, "no request is sent to the other engine in its place");
  assert.notEqual(result.action, "AUTO_APPROVE");
});

test("no fallback: with JEV selected and its transport failing, the OpenAI engine receives zero requests", async () => {
  const { jev, openai, registry } = buildEngines({ jev: "http_error", openai: "ok" });
  const result = await runEngineGate({
    organizationId: "org-parity",
    brandId: "brand-parity",
    gate: "parity",
    subject: { type: "creative", id: "creative-parity" },
    description: "Parity fixture.",
    questions: gateQuestions(REVIEW_ON_UNRESOLVED),
    evidence: copyEvidence,
    selection: { engineId: "jev", source: "workspace" },
    engines: registry,
  });
  assert.equal(jev.calls(), 1);
  assert.equal(openai.calls(), 0, "OpenAI is never called in place of a failing JEV");
  assert.notEqual(result.action, "AUTO_APPROVE");
});

test("no fallback: a JEV engine that throws is recorded as a failure, and OpenAI receives zero requests", async () => {
  const openai = openAiFetch("ok");
  const throwingRouter: JevProviderRouter = {
    decide: async () => {
      throw new Error("router unavailable");
    },
    getProvider: () => {
      throw new Error("not used");
    },
    health: async () => ({ typesafe_direct: { status: "UNAVAILABLE", message: "router down" } }),
  };
  const registry = {
    jev: new JevDecisionEngine(throwingRouter),
    "openai-decisions": new OpenAiDecisionsEngine({ config: { apiKey: "sk-fixture-openai-key-0001", model: "gpt-6-luna", maxRetries: 0 }, fetchImpl: openai.fetchImpl, sleep: async () => {} }),
  } as const;
  const result = await runEngineGate({
    organizationId: "org-parity",
    brandId: "brand-parity",
    gate: "parity",
    subject: { type: "creative", id: "creative-parity" },
    description: "Parity fixture.",
    questions: gateQuestions(REVIEW_ON_UNRESOLVED),
    evidence: copyEvidence,
    selection: { engineId: "jev", source: "workspace" },
    engines: registry,
  });
  assert.equal(result.answers.positioning?.status, "provider_error");
  assert.equal(openai.calls(), 0);
  assert.notEqual(result.action, "AUTO_APPROVE");
});

test("no fallback: production dispatch calls only the selected engine, on both sides", async () => {
  const { jev, openai, registry } = buildEngines({ openai: "http_error" });
  const dispatched: DecisionResult = await decideWithActiveEngine({
    request: contractRequest(),
    engines: registry,
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(dispatched.engineId, "openai-decisions");
  assert.equal(openai.calls(), 1);
  assert.equal(jev.calls(), 0);
});

test("the two engines share the same question kinds and semantics, so the same fixture reads the same way", async () => {
  const { registry } = buildEngines();
  const request = contractRequest();
  const fromJev = await registry.jev.decide(request);
  const fromOpenAi = await registry["openai-decisions"].decide(request);
  assert.equal(fromJev.answers[CONTRACT_KEYS.predicate]?.semantics, fromOpenAi.answers[CONTRACT_KEYS.predicate]?.semantics);
  assert.equal(fromJev.answers[CONTRACT_KEYS.score]?.semantics, "ordered_score");
  assert.equal(fromOpenAi.answers[CONTRACT_KEYS.score]?.semantics, "ordered_score");
  assert.equal(fromJev.answers[CONTRACT_KEYS.choice]?.choice, fromOpenAi.answers[CONTRACT_KEYS.choice]?.choice);
});
