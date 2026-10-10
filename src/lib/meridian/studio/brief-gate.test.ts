import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { evaluateJevGate } from "../jev/reviewer-decision.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "../decisions/types.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { BRIEF_QUESTIONS } from "../jev/questions/brief.ts";
import { briefDeterministicRejections, judgeBriefFit, writeBriefDecision, type BriefBrain, type BriefForGate } from "./brief-gate.server.ts";
import { creativeJudgmentsFromStoredDecision } from "./jev-context.ts";

const brief: BriefForGate = {
  audience: "Busy parents",
  hook: "Dinner on the table in ten minutes",
  message: "A calm dinner plan that needs no planning",
  format: "video",
  cta: "See it in use",
  angle: "dinner in ten minutes",
};
const brain: BriefBrain = {
  positioning: "Helps busy parents plan a calm dinner in ten minutes.",
  valueProposition: "Planned dinners with no planning.",
  tone: "warm",
  prohibitedClaims: "guaranteed",
  wordsToAvoid: "",
};

type Responder = (spec: JevQuestionSpec) => JevAnswer | undefined;

type StoredDecisionRow = {
  id: string;
  decision: string;
  reviewer_decision: string | null;
  probability: number;
  question_id: string;
  question_version: string;
  subject_type: string;
  schema_version: string;
  answer: unknown;
  model_response: unknown;
  evidence: unknown;
  provider: string;
  model: string;
};

// The planner reads the stored brief decision through this same mapping, so the boundary is tested here.
const plannerView = (row: StoredDecisionRow) =>
  creativeJudgmentsFromStoredDecision({
    id: row.id,
    subjectType: row.subject_type,
    questionId: row.question_id,
    questionVersion: row.question_version,
    schemaVersion: row.schema_version,
    decision: row.decision,
    reviewerDecision: row.reviewer_decision,
    answer: row.answer,
    modelResponse: row.model_response,
    evidence: row.evidence,
    provider: row.provider,
    model: row.model,
  });

function answered(spec: JevQuestionSpec, probability: number): JevAnswer {
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
    calibrationStatus: "uncalibrated",
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  } as JevAnswer;
}

function stubEngine(id: DecisionEngineId, options: { respond?: Responder; failure?: boolean } = {}) {
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
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      requests.push(request);
      const failure = options.failure ? { kind: "provider_unavailable" as const, message: "stub outage" } : undefined;
      const answers: Record<string, JevAnswer> = options.failure
        ? abstainAll(request, { status: "provider_error", reason: "stub outage", model: "stub-model", provider: id })
        : {};
      if (!options.failure) {
        for (const [key, spec] of Object.entries(request.questions)) {
          const answer = options.respond?.(spec);
          if (answer) answers[key] = answer;
        }
      }
      const result: DecisionResult = {
        runId: randomUUID(),
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
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
        failure,
      };
      return result;
    },
  };
  return { engine, requests };
}

const registryWith = (jev: ReturnType<typeof stubEngine>, openai: ReturnType<typeof stubEngine>): DecisionEngineRegistry => ({
  jev: jev.engine,
  "openai-decisions": openai.engine,
});

const BRAND = BRIEF_QUESTIONS["brief.brand_fit.v1"]!.id;
const OPPORTUNITY = BRIEF_QUESTIONS["brief.opportunity_fit.v1"]!.id;
const CLAIMS = BRIEF_QUESTIONS["brief.claim_compliance.v1"]!.id;

const approves: Responder = (spec) => {
  if (spec.id === BRAND || spec.id === OPPORTUNITY) return answered(spec, 0.95);
  if (spec.id === CLAIMS) return answered(spec, 0.99);
  return undefined;
};

async function gateBrief(options: {
  tenant: { organizationId: string; brandId: string };
  brief?: BriefForGate;
  engines: DecisionEngineRegistry;
  selected: DecisionEngineId;
}) {
  const sql = await getSql();
  const briefId = `brief-${randomUUID()}`;
  const decisionId = randomUUID();
  const result = await judgeBriefFit({
    sql,
    organizationId: options.tenant.organizationId,
    brandId: options.tenant.brandId,
    briefId,
    brief: options.brief ?? brief,
    brain,
    engines: options.engines,
    selection: { engineId: options.selected, source: "workspace" },
  });
  await writeBriefDecision(sql, {
    organizationId: options.tenant.organizationId,
    brandId: options.tenant.brandId,
    briefId,
    decisionId,
    reviewerId: "test-user",
    result,
  });
  const [row] = await sql<StoredDecisionRow>`select * from jev_decisions where id = ${decisionId}`;
  return { result, row: row!, decisionId, sql };
}

test("the engine judges brand fit, opportunity fit and claim compliance, and the stored decision is that outcome", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-engine-approve");
  const jev = stubEngine("jev", { respond: approves });
  const openai = stubEngine("openai-decisions");
  const { result, row } = await gateBrief({ tenant, engines: registryWith(jev, openai), selected: "jev" });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(row.decision, "AUTO_APPROVE");
  assert.equal(jev.requests.length, 1, "one call to the active engine");
  assert.equal(openai.requests.length, 0, "the other engine is not called");
  assert.deepEqual(Object.values(jev.requests[0]!.questions).map((spec) => spec.id).sort(), [BRAND, CLAIMS, OPPORTUNITY].sort());
  assert.equal(evaluateJevGate({ decision: row.decision, reviewerDecision: "approve" }).status, "ALLOW", "production may proceed");
});

test("a missing mandatory field is a deterministic rejection: the engine is not asked and the brief is blocked", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-missing-field");
  const jev = stubEngine("jev", { respond: approves });
  const openai = stubEngine("openai-decisions", { respond: approves });
  const { result, row } = await gateBrief({ tenant, brief: { ...brief, hook: "" }, engines: registryWith(jev, openai), selected: "openai-decisions" });
  assert.equal(result.action, "REJECT");
  assert.equal(result.engineCalled, false);
  assert.equal(jev.requests.length + openai.requests.length, 0, "no engine is asked to override a missing field");
  assert.equal(row.decision, "REJECT");
  assert.equal(row.reviewer_decision, null, "a rejected brief carries no approval");
  assert.equal(evaluateJevGate({ decision: row.decision, reviewerDecision: null }).status, "BLOCK");
});

test("a stored prohibited claim in the brief text is a deterministic rejection that no engine can override", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-prohibited");
  const jev = stubEngine("jev", { respond: approves });
  const openai = stubEngine("openai-decisions", { respond: approves });
  const { result, row } = await gateBrief({
    tenant,
    brief: { ...brief, message: "A guaranteed calm dinner in ten minutes" },
    engines: registryWith(jev, openai),
    selected: "openai-decisions",
  });
  assert.equal(result.action, "REJECT");
  assert.equal(result.engineCalled, false);
  assert.equal(openai.requests.length + jev.requests.length, 0);
  assert.equal(row.decision, "REJECT");
  assert.match(JSON.stringify(briefDeterministicRejections({ ...brief, message: "guaranteed" }, brain)), /prohibited_claim/);
});

test("claim compliance below its policy rejects the brief, even though brand fit approves", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-claim-policy");
  const jev = stubEngine("jev", {
    respond: (spec) => (spec.id === CLAIMS ? answered(spec, 0.2) : approves(spec)),
  });
  const { result, row } = await gateBrief({ tenant, engines: registryWith(jev, stubEngine("openai-decisions")), selected: "jev" });
  assert.equal(result.action, "REJECT");
  assert.equal(row.decision, "REJECT");
  assert.equal(row.reviewer_decision, null);
});

test("a provider failure on the active engine leaves the brief in human review, never approved, and never switches engines", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-provider-failure");
  const jev = stubEngine("jev", { respond: approves });
  const openai = stubEngine("openai-decisions", { failure: true });
  const { result, row } = await gateBrief({ tenant, engines: registryWith(jev, openai), selected: "openai-decisions" });
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(row.decision, "HUMAN_REVIEW");
  assert.equal(jev.requests.length, 0, "no silent switch to JEV");
  assert.equal(openai.requests.length, 1);
});

test("under JEV the brief is judged by JEV alone, with no images, and a clean judgment is approved", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-jev-only");
  const jev = stubEngine("jev", { respond: approves });
  const openai = stubEngine("openai-decisions", { respond: approves });
  const { result } = await gateBrief({ tenant, engines: registryWith(jev, openai), selected: "jev" });
  assert.equal(result.action, "AUTO_APPROVE");
  assert.equal(openai.requests.length, 0);
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0);
});

test("the brief's decision links to its gate record, with the engine and the policy version", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-record-link");
  const jev = stubEngine("jev", { respond: approves });
  const { result, row, decisionId } = await gateBrief({ tenant, engines: registryWith(jev, stubEngine("openai-decisions")), selected: "jev" });
  const [stored] = await sql<{ evidence: unknown }>`select evidence from jev_decisions where id = ${decisionId}`;
  assert.match(JSON.stringify(stored?.evidence), new RegExp(result.gateRecordId!));
  const [record] = await sql<{ engine_id: string; action: string }>`
    select engine_id, action from decision_gate_records where id = ${result.gateRecordId}
  `;
  assert.equal(record?.engine_id, "jev");
  assert.equal(record?.action, row.decision);
  assert.equal(row.probability >= 0 && row.probability <= 1, true);
});

test("the planner admits an approved brief and blocks a rejected one, reading the stored decision the way production does", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-planner-contract");
  const approved = await gateBrief({ tenant, engines: registryWith(stubEngine("jev", { respond: approves }), stubEngine("openai-decisions")), selected: "jev" });
  const admitted = plannerView(approved.row);
  assert.equal(admitted.status, "admissible", "an approved brief is admissible for planning");
  assert.ok(admitted.evidenceRefs.includes(`gate_record:${approved.result.gateRecordId}`), "the planner can trace the gate record");

  const rejected = await gateBrief({ tenant, brief: { ...brief, hook: "" }, engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions")), selected: "jev" });
  assert.equal(plannerView(rejected.row).status, "abstain_rejected", "a rejected brief blocks planning");
});

test("a brief the engine could not judge is admitted only by the human who approved it, and the planner says so", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "brief-planner-unavailable");
  const failed = await gateBrief({ tenant, engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: "openai-decisions" });
  assert.equal(failed.row.decision, "HUMAN_REVIEW");
  assert.equal(failed.row.reviewer_decision, "approve", "the creating user is the reviewer");
  assert.equal(plannerView(failed.row).status, "admissible");
});
