/**
 * Acceptance tests for the engine gate's evidence scopes and approval defaults (docs/ARCHITECTURE_CONTRACTS.md, sections 2 and 6).
 * Each question sees only its own scope. Evidence for one question never satisfies another. Approval needs a calibrated answer,
 * an explicit policy, and a threshold. A whole-call failure stops the later scopes, and the engine is never switched.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { PNG, studioTenant } from "../testing/durable-image-fixtures.ts";
import { registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import type { DecisionEngineRegistry } from "./dispatcher.ts";
import { IMAGE_SCOPE, runEngineGate, type GateEvidenceInput, type GateImage, type GateQuestion } from "./gate.ts";
import { OpenAiDecisionsEngine } from "./openai-engine.ts";
import type { DecisionEngineId } from "./types.ts";

const BRAND_FIT: JevQuestionSpec = {
  id: "test.brand_fit.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the copy express the positioning?",
  criteria: { true: "It does.", false: "It does not." },
  evidenceRequirements: ["copy", "positioning"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};
const CLAIM: JevQuestionSpec = {
  id: "test.claim.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the copy stay within the brand's claims?",
  criteria: { true: "It does.", false: "It does not." },
  evidenceRequirements: ["copy", "brand_claims"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.95, reviewMinProbability: 0.8 },
};
const VISUAL: JevQuestionSpec = {
  id: "test.visual.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the image free of visible defects?",
  criteria: { true: "No defect.", false: "A defect." },
  evidenceRequirements: ["image"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.7 },
};
const PRODUCT: JevQuestionSpec = {
  id: "test.product.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Is the product visible?",
  criteria: { true: "Visible.", false: "Not visible." },
  evidenceRequirements: ["image", "product_name"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};
const FREE: JevQuestionSpec = {
  id: "test.free.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "A question that needs no evidence.",
  criteria: { true: "Yes.", false: "No." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
};

const COPY: GateEvidenceInput = { kind: "text", name: "copy", source: "test", content: { copy: "A calm dinner in ten minutes." } };
const POSITIONING: GateEvidenceInput = { kind: "text", name: "positioning", source: "test", content: { positioning: "Calm dinners for busy parents." } };
const CLAIMS: GateEvidenceInput = { kind: "text", name: "brand_claims", source: "test", content: { claims: "Plan dinners in ten minutes." } };
const FRAME: GateEvidenceInput = { kind: "image", name: "frame-0", sha256: "a".repeat(64), source: "test" };
const PRODUCT_NAME: GateEvidenceInput = { kind: "text", name: "product_name", source: "test", content: { productName: "MealKit" } };
const OBSERVATIONS: GateEvidenceInput = {
  kind: "text",
  name: "perception_observations",
  source: "test",
  content: { contracts: { visual_quality: ["Frame at 0ms [visual_quality 1.0.0] sharpness=sharp"] } },
};
const IMAGE: GateImage = { bytes: PNG, label: "Frame at 0ms", evidenceName: "frame-0" };

function answer(spec: JevQuestionSpec, probability: number, calibrationStatus: "calibrated" | "uncalibrated"): JevAnswer {
  return {
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "stub-model",
    provider: "stub",
    status: "answered",
    answer: probability >= 0.5,
    probability,
    noul: probability,
    semantics: "probability",
    calibrationStatus,
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  } as JevAnswer;
}

/** Answers every question as a confident approval, calibrated, so each question clears its own threshold. */
const approveAll = (spec: JevQuestionSpec) => answer(spec, 0.99, "calibrated");

async function judge(options: {
  tenant: { organizationId: string; brandId: string };
  questions: GateQuestion[];
  evidence: GateEvidenceInput[];
  images?: GateImage[];
  selected: DecisionEngineId;
  engines: DecisionEngineRegistry;
  deterministicRejections?: Array<{ rule: string; reason: string }>;
}) {
  return runEngineGate({
    sql: await getSql(),
    organizationId: options.tenant.organizationId,
    brandId: options.tenant.brandId,
    gate: "evidence_scope_test",
    subject: { type: "creative", id: `creative-${randomUUID()}` },
    description: "Evidence scope test subject.",
    questions: options.questions,
    evidence: options.evidence,
    images: options.images,
    deterministicRejections: options.deterministicRejections,
    selection: { engineId: options.selected, source: "workspace" },
    engines: options.engines,
  });
}

test("scope isolation: the brand-fit call holds no image and no observation, and each call names only its own scope", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-isolation");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: approveAll });
  const result = await judge({
    tenant,
    questions: [
      { key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] },
      { key: "claim", spec: CLAIM, needsImage: false, evidenceScope: ["copy", "brand_claims"] },
      { key: "visual", spec: VISUAL, needsImage: true, evidenceScope: [IMAGE_SCOPE] },
    ],
    evidence: [COPY, POSITIONING, CLAIMS, FRAME, OBSERVATIONS],
    images: [IMAGE],
    selected: "openai-decisions",
    engines: registryWith(jev, openai),
  });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(openai.requests.length, 3, "one call per evidence scope");
  assert.equal(jev.requests.length, 0);
  const callFor = (key: string) => openai.requests.find((request) => key in request.questions)!;
  const brand = callFor("brand");
  assert.deepEqual([...(brand.state.availableEvidence as string[])].sort(), ["copy", "positioning"]);
  assert.equal(brand.images?.length ?? 0, 0, "brand fit receives no image");
  assert.doesNotMatch(JSON.stringify(brand.state), /perception|frame-0|"image"/, "brand fit receives no observation and no image name");
  const claim = callFor("claim");
  assert.deepEqual([...(claim.state.availableEvidence as string[])].sort(), ["brand_claims", "copy"]);
  assert.equal(claim.images?.length ?? 0, 0, "claim compliance receives no image");
  assert.doesNotMatch(JSON.stringify(claim.state), /perception|frame-0/);
  const visual = callFor("visual");
  assert.equal(visual.images?.length, 1, "only the visual question carries the image");
  assert.deepEqual([...(visual.state.availableEvidence as string[])].sort(), ["frame-0", IMAGE_SCOPE]);
  assert.doesNotMatch(JSON.stringify(visual.state), /perception/, "the observations are in no scope that asked for them");
});

test("evidence isolation: evidence supplied for one question does not satisfy another question's requirement", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-isolation-requirement");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: approveAll });
  const result = await judge({
    tenant,
    questions: [
      { key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] },
      // product_name is supplied, but only the brand question's scope could hold it, and this scope does not name it.
      { key: "product", spec: PRODUCT, needsImage: true, evidenceScope: [IMAGE_SCOPE] },
    ],
    evidence: [COPY, POSITIONING, PRODUCT_NAME, FRAME],
    images: [IMAGE],
    selected: "openai-decisions",
    engines: registryWith(jev, openai),
  });
  const product = result.unresolved.find((item) => item.questionId === PRODUCT.id);
  assert.equal(product?.status, "abstain_insufficient_evidence");
  assert.match(product?.reason ?? "", /product_name/, "the missing requirement is named");
  assert.equal(openai.requests.length, 1, "only the brand-fit scope is called");
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("a question with no scope receives no evidence: it abstains without a call, and a question that needs none is never approved from an empty scope", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-no-scope");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: approveAll });
  const result = await judge({
    tenant,
    questions: [
      { key: "brand", spec: BRAND_FIT, needsImage: false },
      { key: "free", spec: FREE, needsImage: false },
    ],
    evidence: [COPY, POSITIONING],
    selected: "openai-decisions",
    engines: registryWith(jev, openai),
  });
  assert.equal(result.unresolved.find((item) => item.questionId === BRAND_FIT.id)?.status, "abstain_insufficient_evidence");
  assert.equal(openai.requests.length, 1, "only the question that needs no evidence is asked");
  assert.deepEqual(Object.keys(openai.requests[0]!.questions), ["free"]);
  const free = result.unresolved.find((item) => item.questionId === FREE.id);
  assert.match(free?.reason ?? "", /scope/, "an answer from an empty scope cannot approve");
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("calibration: an uncalibrated probability above the approval threshold is review, and the same value calibrated is approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-calibration");
  const questions: GateQuestion[] = [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }];
  const uncalibrated = await judge({
    tenant,
    questions,
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: (spec) => answer(spec, 0.99, "uncalibrated") }), stubEngine("openai-decisions")),
  });
  assert.equal(uncalibrated.action, "HUMAN_REVIEW", "an uncalibrated probability is never an approval");
  assert.equal(uncalibrated.votes[0]?.calibrationStatus, "uncalibrated");
  const calibrated = await judge({
    tenant,
    questions,
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: (spec) => answer(spec, 0.99, "calibrated") }), stubEngine("openai-decisions")),
  });
  assert.equal(calibrated.action, "AUTO_APPROVE");
  assert.equal(calibrated.votes[0]?.calibrationStatus, "calibrated");
});

test("missing policy: a question with no policy mapping is review, however confident its calibrated answer", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-no-policy");
  const noPolicy: JevQuestionSpec = { ...BRAND_FIT, id: "test.no_policy.v1", policyMapping: undefined };
  const result = await judge({
    tenant,
    questions: [{ key: "nopolicy", spec: noPolicy, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: (spec) => answer(spec, 0.999, "calibrated") }), stubEngine("openai-decisions")),
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.unresolved[0]?.status, "no_policy");
});

test("missing threshold: a question whose policy names no approveMinProbability is review, however confident its calibrated answer", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-no-threshold");
  const noThreshold: JevQuestionSpec = { ...BRAND_FIT, id: "test.no_threshold.v1", policyMapping: { predicateDirection: "pass_if_true", reviewMinProbability: 0.6 } };
  const result = await judge({
    tenant,
    questions: [{ key: "nothreshold", spec: noThreshold, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: (spec) => answer(spec, 0.999, "calibrated") }), stubEngine("openai-decisions")),
  });
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("unresolved answers: a refused answer is review, never approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-refused");
  const refused = (spec: JevQuestionSpec): JevAnswer => ({
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "stub-model",
    provider: "stub",
    status: "refused",
    evidenceRefs: [],
    abstainReason: "The provider declined.",
    evaluatedAt: new Date().toISOString(),
  });
  const result = await judge({
    tenant,
    questions: [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: refused }), stubEngine("openai-decisions")),
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.unresolved[0]?.status, "refused");
});

test("regression: dropping the approveMinProbability mapping from a previously approving question turns its approval into review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-regression");
  const dropped: JevQuestionSpec = { ...BRAND_FIT, policyMapping: { predicateDirection: "pass_if_true", reviewMinProbability: 0.6 } };
  const engines = (): DecisionEngineRegistry => registryWith(stubEngine("jev", { respond: (spec) => answer(spec, 0.97, "calibrated") }), stubEngine("openai-decisions"));
  const before = await judge({
    tenant,
    questions: [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: engines(),
  });
  assert.equal(before.action, "AUTO_APPROVE", "with the threshold, the calibrated answer approves");
  const after = await judge({
    tenant,
    questions: [{ key: "brand", spec: dropped, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: engines(),
  });
  assert.equal(after.action, "HUMAN_REVIEW", "without the threshold, the same answer can only go to review");
});

test("a literal prohibited claim is refused before the engine is called: the stub records zero requests", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-deterministic");
  const jev = stubEngine("jev", { respond: approveAll });
  const openai = stubEngine("openai-decisions", { respond: approveAll });
  const result = await judge({
    tenant,
    questions: [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    deterministicRejections: [{ rule: "prohibited_claim", reason: "The copy contains the stored prohibited claim “guaranteed”." }],
    selected: "openai-decisions",
    engines: registryWith(jev, openai),
  });
  assert.equal(result.action, "REJECT");
  assert.equal(result.engineCalled, false);
  assert.equal(jev.requests.length + openai.requests.length, 0, "no engine is asked to override a literal rejection");
});

test("engine isolation: with OpenAI selected and failing, the JEV stub receives zero requests", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-isolation-openai-down");
  const jev = stubEngine("jev", { respond: approveAll });
  const openai = stubEngine("openai-decisions", { failure: true });
  const result = await judge({
    tenant,
    questions: [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "openai-decisions",
    engines: registryWith(jev, openai),
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(openai.requests.length, 1);
  assert.equal(jev.requests.length, 0, "the other engine is never called in its place");
});

test("engine isolation: with JEV selected and failing, the OpenAI stub receives zero requests", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-isolation-jev-down");
  const jev = stubEngine("jev", { failure: true });
  const openai = stubEngine("openai-decisions", { respond: approveAll });
  const result = await judge({
    tenant,
    questions: [{ key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] }],
    evidence: [COPY, POSITIONING],
    selected: "jev",
    engines: registryWith(jev, openai),
  });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(jev.requests.length, 1);
  assert.equal(openai.requests.length, 0, "the other engine is never called in its place");
});

test("a whole-call failure stops the later scopes: they are not sent, and their questions are recorded as not sent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-early-stop");
  const openai = stubEngine("openai-decisions", { failure: true });
  const result = await judge({
    tenant,
    questions: [
      { key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] },
      { key: "claim", spec: CLAIM, needsImage: false, evidenceScope: ["copy", "brand_claims"] },
    ],
    evidence: [COPY, POSITIONING, CLAIMS],
    selected: "openai-decisions",
    engines: registryWith(stubEngine("jev"), openai),
  });
  assert.equal(openai.requests.length, 1, "the first scope is sent, and the second is not");
  assert.equal(result.calls.length, 2);
  const skipped = result.calls.find((call) => call.questionKeys.includes("claim"));
  assert.equal(skipped?.skipped, true);
  assert.equal(skipped?.engineCalled, false);
  const notSent = result.unresolved.find((item) => item.questionId === CLAIM.id);
  assert.equal(notSent?.status, "provider_error");
  assert.match(notSent?.reason ?? "", /Not sent/);
  assert.equal(result.action, "HUMAN_REVIEW");
});

test("provenance: each vote names its scope, its model, and the run that answered it, and the record keeps them", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-provenance");
  const result = await judge({
    tenant,
    questions: [
      { key: "brand", spec: BRAND_FIT, needsImage: false, evidenceScope: ["copy", "positioning"] },
      { key: "claim", spec: CLAIM, needsImage: false, evidenceScope: ["copy", "brand_claims"] },
    ],
    evidence: [COPY, POSITIONING, CLAIMS],
    selected: "jev",
    engines: registryWith(stubEngine("jev", { respond: approveAll }), stubEngine("openai-decisions")),
  });
  assert.equal(result.action, "AUTO_APPROVE");
  const brandVote = result.votes.find((vote) => vote.questionId === BRAND_FIT.id);
  const claimVote = result.votes.find((vote) => vote.questionId === CLAIM.id);
  assert.deepEqual(brandVote?.scope, ["copy", "positioning"]);
  assert.deepEqual(claimVote?.scope, ["brand_claims", "copy"]);
  assert.equal(brandVote?.model, "stub-model");
  assert.ok(brandVote?.runId && claimVote?.runId, "each vote names its run");
  assert.notEqual(brandVote?.runId, claimVote?.runId, "two scopes, two runs");
  assert.equal(brandVote?.runId, result.calls.find((call) => call.questionKeys.includes("brand"))?.runId);
  const [record] = await sql<{ votes: Array<{ questionId: string; scope: string[]; model: string; runId: string }> }>`
    select votes from decision_gate_records where id = ${result.gateRecordId}
  `;
  const stored = record?.votes.find((vote) => vote.questionId === BRAND_FIT.id);
  assert.deepEqual(stored?.scope, ["copy", "positioning"]);
  assert.equal(stored?.runId, brandVote?.runId);
});

test("the OpenAI adapter receives the visual question with the image, because the gate names the image scope", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "evidence-scope-openai-name");
  const sent: string[] = [];
  // A rejected request, so no answer is produced. The test is about whether the question was sent at all.
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ error: { message: "stub refusal" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const openai = new OpenAiDecisionsEngine({
    config: { apiKey: "test-key-not-real", baseUrl: "https://decisions.invalid/v1", model: "test-decisions-model", timeoutMs: 5000, maxRetries: 0 },
    fetchImpl,
  });
  const jev = stubEngine("jev");
  const result = await judge({
    tenant,
    questions: [{ key: "visual", spec: VISUAL, needsImage: true, evidenceScope: [IMAGE_SCOPE] }],
    evidence: [FRAME],
    images: [IMAGE],
    selected: "openai-decisions",
    engines: { jev: jev.engine, "openai-decisions": openai },
  });
  assert.equal(sent.length, 1, "the visual question is sent to OpenAI");
  assert.match(sent[0]!, /input_image/, "the image is sent with the question");
  const visual = result.unresolved.find((item) => item.questionId === VISUAL.id);
  assert.notEqual(visual?.status, "abstain_insufficient_evidence", "the question is not abstained for an evidence-name mismatch");
  assert.equal(result.action, "HUMAN_REVIEW", "a failed call is review, never approval");
  assert.equal(jev.requests.length, 0);
});
