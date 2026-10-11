import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { PNG, studioTenant } from "../testing/durable-image-fixtures.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { IMAGE_SCOPE, runEngineGate, type GateEvidenceInput, type GateQuestion } from "./gate.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "./types.ts";

// Gate questions. Each carries an explicit policy mapping so the thresholds under test are visible here.
const SAFETY: JevQuestionSpec = {
  id: "test.claim_safety.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the copy free of unsubstantiated claims?",
  criteria: { true: "No unsubstantiated claim.", false: "Contains an unsubstantiated claim." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.95, reviewMinProbability: 0.8 },
};
const DEFECT: JevQuestionSpec = {
  id: "test.prohibited_claim.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the copy contain a prohibited claim?",
  criteria: { true: "Contains a prohibited claim.", false: "No prohibited claim." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "reject_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6, unresolvedOutcome: "REJECT" },
};
const TONE: JevQuestionSpec = {
  id: "test.tone.v1",
  version: "1.0.0",
  type: "choice",
  instructions: "Which tone does the copy use?",
  criteria: { organic: "Conversational.", hard_sell: "Pushy.", prohibited: "Forbidden tone." },
  evidenceRequirements: ["copy"],
  policyMapping: { approveValues: ["organic"], rejectionValues: ["prohibited"] },
};
const PRODUCT_IN_IMAGE: JevQuestionSpec = {
  id: "test.product_visible.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the product visible in the image?",
  criteria: { true: "Visible.", false: "Not visible." },
  evidenceRequirements: ["image"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};
const UNMAPPED: JevQuestionSpec = {
  id: "test.unmapped.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "An unmapped question.",
  criteria: { true: "Yes.", false: "No." },
  evidenceRequirements: [],
};

/** The text evidence the questions in this file read. Its content reaches only questions whose scope names it. */
const COPY_EVIDENCE: GateEvidenceInput = { kind: "text", name: "copy", source: "test", content: { copy: "A plain product description." } };
/** One image item. It reaches only questions whose scope is IMAGE_SCOPE. */
const IMAGE_EVIDENCE: GateEvidenceInput = { kind: "image", name: "frame-0", sha256: "f".repeat(64), source: "test" };

const questions = (): GateQuestion[] => [
  { key: "safety", spec: SAFETY, needsImage: false, evidenceScope: ["copy"] },
  { key: "tone", spec: TONE, needsImage: false, evidenceScope: ["copy"] },
];

type Responder = (key: string, spec: JevQuestionSpec) => JevAnswer | undefined;

type AnswerBody = { probability?: number; choice?: string; confidence?: number; calibrated?: boolean };

function answered(spec: JevQuestionSpec, body: AnswerBody): JevAnswer {
  const base = {
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "stub-model",
    provider: "stub",
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  };
  // A calibration is stated by the answer. Engines report "uncalibrated" today; a test sets "calibrated" to model a calibrated value.
  const calibrationStatus = body.calibrated ? "calibrated" : "uncalibrated";
  if (typeof body.probability === "number") {
    return { ...base, status: "answered", answer: body.probability >= 0.5, probability: body.probability, noul: body.probability,
      semantics: "probability", calibrationStatus, confidence: body.confidence } as JevAnswer;
  }
  return { ...base, status: "answered", answer: body.choice ?? "", choice: body.choice, probabilities: { [body.choice ?? ""]: 1 },
    semantics: "categorical", calibrationStatus, confidence: body.confidence } as JevAnswer;
}

// A counting stub engine. It answers from `respond`, or fails every question when `failure` is set. It records every call.
function stubEngine(id: DecisionEngineId, options: { respond?: Responder; failure?: DecisionResult["failure"]; throws?: boolean } = {}) {
  const requests: DecisionRequest[] = [];
  const engine: DecisionEngine = {
    id,
    adapterVersion: `${id}-stub.v1`,
    capabilities: () => ({
      engineId: id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: id === "openai-decisions" ? ["text", "image"] : ["text"],
      maxImages: id === "openai-decisions" ? 128 : 0,
      maxImageBytes: 20 * 1024 * 1024,
      imageMimeTypes: id === "openai-decisions" ? ["image/png"] : [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      requests.push(request);
      if (options.throws) throw new Error("socket hang up");
      const answers: Record<string, JevAnswer> = {};
      if (options.failure) {
        Object.assign(answers, abstainAll(request, { status: "provider_error", reason: options.failure.message, model: "stub-model", provider: id }));
      } else {
        for (const [key, spec] of Object.entries(request.questions)) {
          const answer = options.respond?.(key, spec);
          if (answer) answers[key] = answer;
        }
      }
      return {
        runId: globalThis.crypto.randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "stub-hash",
        cached: false,
        latencyMs: 2,
        answers,
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: request.images && request.images.length > 0 ? "text+image" : "text",
        imageCount: request.images?.length ?? 0,
        imagesOmitted: 0,
        failure: options.failure,
      };
    },
  };
  return { engine, requests };
}

const engineFor = (jev: ReturnType<typeof stubEngine>, openai: ReturnType<typeof stubEngine>) => ({
  jev: jev.engine,
  "openai-decisions": openai.engine,
});

const healthyAnswers: Responder = (key, spec) => {
  if (spec.id === SAFETY.id) return answered(spec, { probability: 0.99, calibrated: true });
  if (spec.id === TONE.id) return answered(spec, { choice: "organic", confidence: 0.9 });
  if (spec.id === PRODUCT_IN_IMAGE.id) return answered(spec, { probability: 0.97, calibrated: true });
  return undefined;
};

async function gate(overrides: Partial<Parameters<typeof runEngineGate>[0]> & { tenant: { organizationId: string; brandId: string } }) {
  const { tenant, ...rest } = overrides;
  return runEngineGate({
    sql: await getSql(),
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    gate: "test_gate",
    subject: { type: "creative", id: `creative-${globalThis.crypto.randomUUID()}` },
    description: "Test creative.",
    questions: questions(),
    evidence: [COPY_EVIDENCE],
    ...rest,
  });
}

test("JEV selected: text questions go to JEV once, OpenAI is never called, and the result is AUTO_APPROVE", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-jev-approve");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    engines: engineFor(jev, openai),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(result.engineId, "jev");
  assert.equal(result.engineCalled, true);
  assert.equal(jev.requests.length, 1, "both questions share one scope, so one engine call");
  assert.equal(openai.requests.length, 0, "the other engine was not called");
  assert.deepEqual(Object.keys(jev.requests[0]!.questions).sort(), ["safety", "tone"]);
});

test("OpenAI selected: the same text decision is made by OpenAI and JEV is never called", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-openai-approve");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(result.engineId, "openai-decisions");
  assert.equal(openai.requests.length, 1);
  assert.equal(jev.requests.length, 0);
});

test("image evidence under OpenAI: each scope is one call, the image reaches only the image question, and the record names what was sent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-openai-image");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const imageQuestions: GateQuestion[] = [...questions(), { key: "product", spec: PRODUCT_IN_IMAGE, needsImage: true, evidenceScope: [IMAGE_SCOPE] }];
  const result = await gate({
    tenant,
    questions: imageQuestions,
    evidence: [COPY_EVIDENCE, IMAGE_EVIDENCE],
    images: [{ bytes: PNG, label: "Frame at 3.2s", evidenceRef: { field: "scene", location: { startMs: 3200 } }, evidenceName: "frame-0" }],
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(openai.requests.length, 2, "one call for the text scope, one for the image scope");
  const imageCall = openai.requests.find((request) => (request.images?.length ?? 0) > 0);
  const textCall = openai.requests.find((request) => (request.images?.length ?? 0) === 0);
  assert.ok(imageCall && textCall, "one call carries the image and the other carries no image");
  assert.equal(imageCall.images?.length, 1);
  assert.deepEqual([...(imageCall.state.availableEvidence as string[])].sort(), ["frame-0", IMAGE_SCOPE]);
  assert.deepEqual(textCall.state.availableEvidence, ["copy"], "the text call names only its own scope");
  assert.equal(result.imagesSent, 1);
  assert.equal(result.imagesOmitted, 0);
  const [record] = await sql<{ engine_called: boolean; engine_id: string; action: string; evidence: string }>`
    select engine_called, engine_id, action, evidence from decision_gate_records where id = ${result.gateRecordId}
  `;
  assert.equal(record?.engine_called, true);
  assert.equal(record?.engine_id, "openai-decisions");
  assert.equal(record?.action, "AUTO_APPROVE");
  assert.ok(!record?.evidence.includes("iVBOR"), "image bytes are never written to the record");
});

test("JEV selected: an image question is refused locally as unsupported and routes to human review; no image is sent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-jev-image");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    questions: [...questions(), { key: "product", spec: PRODUCT_IN_IMAGE, needsImage: true, evidenceScope: [IMAGE_SCOPE] }],
    evidence: [COPY_EVIDENCE, IMAGE_EVIDENCE],
    images: [{ bytes: PNG, evidenceName: "frame-0" }],
    engines: engineFor(jev, openai),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(openai.requests.length, 0, "no silent OpenAI call for visual judgment");
  assert.equal(jev.requests.length, 1, "the text questions still go to JEV");
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0, "JEV is never handed image bytes");
  assert.equal(result.imagesSent, 0);
  assert.equal(result.imagesOmitted, 1);
  const refused = result.unresolved.find((item) => item.questionId === PRODUCT_IN_IMAGE.id);
  assert.equal(refused?.status, "unsupported");
});

test("JEV selected with only image questions: no engine is called at all", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-jev-image-only");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    questions: [{ key: "product", spec: PRODUCT_IN_IMAGE, needsImage: true, evidenceScope: [IMAGE_SCOPE] }],
    evidence: [IMAGE_EVIDENCE],
    images: [{ bytes: PNG, evidenceName: "frame-0" }],
    engines: engineFor(jev, openai),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.engineCalled, false);
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(jev.requests.length + openai.requests.length, 0);
});

test("OpenAI selected but no image in the scope: the image question abstains for insufficient evidence, not an approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-openai-no-image");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    questions: [{ key: "product", spec: PRODUCT_IN_IMAGE, needsImage: true, evidenceScope: [IMAGE_SCOPE] }],
    evidence: [COPY_EVIDENCE],
    images: [],
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.unresolved[0]?.status, "abstain_insufficient_evidence");
  assert.equal(openai.requests.length, 0, "nothing to judge, so nothing is sent");
});

test("a provider failure resolves to human review; the other engine is not called in its place", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-provider-failure");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { failure: { kind: "rate_limited", message: "429 from provider" } });
  const result = await gate({
    tenant,
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.failureKind, "rate_limited");
  assert.equal(jev.requests.length, 0, "no silent switch to the other engine");
  assert.equal(openai.requests.length, 1);
});

test("an engine that throws fails closed: the failure is recorded and nothing is approved", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-engine-throws");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { throws: true });
  const result = await gate({
    tenant,
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.notEqual(result.action, "AUTO_APPROVE");
  assert.equal(result.failureKind, "provider_unavailable");
  assert.equal(jev.requests.length, 0);
  assert.equal(result.unresolved.every((item) => item.status === "provider_error"), true);
});

test("a deterministic rejection cannot be overridden: the engine is not called and the subject is REJECTed", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-deterministic");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    deterministicRejections: [{ rule: "source_permission", reason: "The source does not allow this use." }],
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "REJECT");
  assert.equal(result.engineCalled, false);
  assert.equal(openai.requests.length + jev.requests.length, 0, "an engine that would approve is never asked");
  assert.match(result.reason, /source_permission/);
  const [record] = await sql<{ engine_called: boolean; deterministic_rejections: unknown }>`
    select engine_called, deterministic_rejections from decision_gate_records where id = ${result.gateRecordId}
  `;
  assert.equal(record?.engine_called, false);
  assert.match(JSON.stringify(record?.deterministic_rejections), /source_permission/);
});

test("policy enforcement: a calibrated predicate is approved above its threshold, reviewed in its band, and rejected below it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-policy-bands");
  const run = async (probability: number) => {
    const jev = stubEngine("jev", {
      respond: (key, spec) => (spec.id === SAFETY.id ? answered(spec, { probability, calibrated: true }) : answered(TONE, { choice: "organic" })),
    });
    const openai = stubEngine("openai-decisions");
    return gate({ tenant, engines: engineFor(jev, openai), selection: { engineId: "jev", source: "workspace" } });
  };
  assert.equal((await run(0.99)).action, "AUTO_APPROVE", "at or above the approve threshold");
  assert.equal((await run(0.9)).action, "HUMAN_REVIEW", "inside the review band");
  assert.equal((await run(0.5)).action, "REJECT", "below the review band the predicate fails");
});

test("policy enforcement: a calibrated reject-if-true predicate rejects when the defect is likely", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-defect-direction");
  const questionsWithDefect: GateQuestion[] = [{ key: "defect", spec: DEFECT, needsImage: false, evidenceScope: ["copy"] }];
  const run = async (defect: number) => {
    const jev = stubEngine("jev", { respond: (_key, spec) => answered(spec, { probability: defect, calibrated: true }) });
    return gate({
      tenant,
      questions: questionsWithDefect,
      engines: engineFor(jev, stubEngine("openai-decisions")),
      selection: { engineId: "jev", source: "workspace" },
    });
  };
  assert.equal((await run(0.05)).action, "AUTO_APPROVE");
  assert.equal((await run(0.3)).action, "HUMAN_REVIEW");
  const rejected = await run(0.9);
  assert.equal(rejected.action, "REJECT");
  assert.equal(rejected.votes[0]?.outcome, "REJECT");
});

test("policy enforcement: a choice in the rejection list rejects, and an unlisted choice goes to review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-choice");
  const run = async (choice: string) => {
    const jev = stubEngine("jev", {
      respond: (_key, spec) => (spec.id === TONE.id ? answered(spec, { choice, confidence: 0.9 }) : answered(SAFETY, { probability: 0.99, calibrated: true })),
    });
    return gate({ tenant, engines: engineFor(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } });
  };
  assert.equal((await run("organic")).action, "AUTO_APPROVE");
  assert.equal((await run("prohibited")).action, "REJECT");
  assert.equal((await run("hard_sell")).action, "HUMAN_REVIEW");
});

test("policy enforcement: a low-confidence answer goes to review even when its value would approve", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-low-confidence");
  const LOW_CONFIDENCE_SPEC: JevQuestionSpec = { ...SAFETY, policyMapping: { ...SAFETY.policyMapping, minConfidence: 0.7 } };
  const jev = stubEngine("jev", { respond: (_key, spec) => answered(spec, { probability: 0.99, confidence: 0.3, calibrated: true }) });
  const result = await gate({
    tenant,
    questions: [{ key: "safety", spec: LOW_CONFIDENCE_SPEC, needsImage: false, evidenceScope: ["copy"] }],
    engines: engineFor(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("policy enforcement: a missing answer resolves to the question's unresolved outcome", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-missing");
  // The engine answers the choice question only. The safety question is missing from the response.
  const jev = stubEngine("jev", { respond: (_key, spec) => (spec.id === TONE.id ? answered(spec, { choice: "organic", confidence: 0.9 }) : undefined) });
  const result = await gate({ tenant, engines: engineFor(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.unresolved.find((item) => item.questionId === SAFETY.id)?.status, "missing");
});

test("policy enforcement: a missing answer to a REJECT-by-default question rejects", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-missing-reject");
  const jev = stubEngine("jev", { respond: () => undefined });
  const result = await gate({
    tenant,
    questions: [{ key: "defect", spec: DEFECT, needsImage: false, evidenceScope: ["copy"] }],
    engines: engineFor(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "REJECT");
});

test("policy enforcement: a question with no policy mapping never auto-approves, however confident the answer", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-unmapped");
  const jev = stubEngine("jev", { respond: (_key, spec) => answered(spec, { probability: 0.999, calibrated: true }) });
  const result = await gate({
    tenant,
    questions: [{ key: "unmapped", spec: UNMAPPED, needsImage: false, evidenceScope: ["copy"] }],
    engines: engineFor(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.match(result.policyVersion, new RegExp(`${UNMAPPED.id}@`));
});

test("a refused answer from the engine resolves to the unresolved outcome, never to approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-refused");
  const jev = stubEngine("jev", {
    respond: (_key, spec) => ({
      questionId: spec.id,
      questionVersion: spec.version,
      type: spec.type,
      model: "stub-model",
      provider: "stub",
      status: "refused",
      evidenceRefs: [],
      abstainReason: "The provider declined.",
      evaluatedAt: new Date().toISOString(),
    }),
  });
  const result = await gate({ tenant, engines: engineFor(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.ok(result.unresolved.every((item) => item.status === "refused"));
});

test("every decision persists a gate record with versions, engine, action, reason, and latency", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-record");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const result = await gate({ tenant, engines: engineFor(jev, stubEngine("openai-decisions")), selection: { engineId: "jev", source: "workspace" } });
  assert.ok(result.gateRecordId, "the record id is returned");
  const [record] = await sql<{
    engine_id: string; policy_version: string; question_versions: unknown; action: string; reason: string; latency_ms: number; run_id: string | null;
  }>`
    select engine_id, policy_version, question_versions, action, reason, latency_ms, run_id from decision_gate_records where id = ${result.gateRecordId}
  `;
  assert.equal(record?.engine_id, "jev");
  assert.equal(record?.action, "AUTO_APPROVE");
  assert.match(JSON.stringify(record?.question_versions), /test\.claim_safety\.v1@1\.0\.0/);
  assert.match(record?.policy_version ?? "", /test\.claim_safety\.v1@/);
  assert.ok((record?.latency_ms ?? -1) >= 0);
  assert.ok(record?.reason.includes("jev"));
  assert.equal(record?.run_id, result.runId, "the engine run is linked by id");
});

test("questions that share a scope are asked in one engine call, however many they are", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-single-call");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  await gate({ tenant, engines: engineFor(jev, openai), selection: { engineId: "jev", source: "workspace" } });
  assert.equal(jev.requests.length, 1);
  assert.equal(openai.requests.length, 0);
});

test("analysis questions are answered and recorded, but only gating questions decide the action", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-analysis-only");
  const jev = stubEngine("jev", {
    respond: (key, spec) => (spec.id === TONE.id ? answered(spec, { probability: 0.1 }) : answered(SAFETY, { probability: 0.99, calibrated: true })),
  });
  const result = await gate({
    tenant,
    questions: [
      { key: "safety", spec: SAFETY, needsImage: false, gating: true, evidenceScope: ["copy"] },
      { key: "tone", spec: TONE, needsImage: false, gating: false, evidenceScope: ["copy"] },
    ],
    engines: engineFor(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "AUTO_APPROVE", "a non-gating answer does not reject or block approval");
  assert.ok(result.answers.tone, "the analysis answer is returned under the caller key");
  assert.equal(result.votes.some((vote) => vote.questionId === TONE.id), false);
});

test("a gate with no gating question cannot approve: it goes to review and says why", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-no-gating");
  const jev = stubEngine("jev", { respond: (_key, spec) => answered(spec, { choice: "organic", confidence: 0.9 }) });
  const result = await gate({
    tenant,
    questions: [{ key: "tone", spec: TONE, needsImage: false, gating: false, evidenceScope: ["copy"] }],
    engines: engineFor(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.match(result.reason, /No gating question was asked/);
  assert.equal(jev.requests.length, 1, "the analysis answer is still obtained in the one call");
});

test("a text-only gate never transmits images, even when OpenAI is selected and an image item was supplied", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "gate-text-only-no-images");
  const jev = stubEngine("jev", { respond: healthyAnswers });
  const openai = stubEngine("openai-decisions", { respond: healthyAnswers });
  const result = await gate({
    tenant,
    evidence: [COPY_EVIDENCE, IMAGE_EVIDENCE],
    images: [{ bytes: PNG, evidenceName: "frame-0" }],
    engines: engineFor(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(openai.requests[0]!.images?.length ?? 0, 0, "no image leaves Meridian for text-only questions");
  assert.equal(result.imagesSent, 0);
  assert.equal(result.imagesOmitted, 1, "the supplied image is recorded as not sent");
});
