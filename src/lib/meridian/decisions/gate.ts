/**
 * The engine gate: one path for every production decision that needs contextual judgment.
 *
 * Order of evaluation, and why:
 * 1. Deterministic rejections come first. Budget, source permission, media integrity, schema, provider capability,
 *    and rights are checked by code. If one fails, the gate rejects and no engine is called. An engine can never
 *    override a deterministic rejection.
 * 2. The active engine is resolved once, and only that engine is called, once. There is no fallback to the other
 *    engine and no second opinion from it.
 * 3. A question that needs an image is refused locally when the active engine cannot take images (JEV), or when no
 *    image was supplied. It is never sent to another engine to make up for the gap.
 * 4. Each question is evaluated under its own policy, from the registry. The most severe outcome wins. A refused,
 *    unsupported, malformed, or missing answer, or a provider failure, resolves to the question's unresolved outcome,
 *    which is human review unless the question says otherwise. Nothing is approved automatically on an unresolved answer.
 * 5. The decision is persisted with its versions, engine, model, evidence, votes, action, reason, latency, and usage.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { decideWithActiveEngine, type DecisionEngineRegistry } from "./dispatcher.ts";
import { evaluateQuestionPolicies, policyForQuestion, type PolicyOutcome } from "./policy.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import { abstainAll, type DecisionImageInput, type DecisionRequest, type DecisionUsage } from "./types.ts";
import type { JevRoutingPolicy } from "../jev/types.ts";

export type GateQuestion = {
  /** The key the caller uses for this question. Answers are keyed by it. */
  key: string;
  spec: JevQuestionSpec;
  /** True when the question cannot be answered from text alone. */
  needsImage: boolean;
  /**
   * False for analysis questions: they are answered and recorded, but they do not decide the action. Default true.
   * A gate with no gating question cannot approve anything, so its action is review.
   */
  gating?: boolean;
};

/** One piece of evidence the caller actually provided. Recorded so a reviewer can see exactly what was judged. */
export type GateEvidence = {
  kind: "text" | "image";
  /** Stable name. Listed to the engine as available evidence. */
  name: string;
  /** Hash of the content, for images and long text. Never the content itself. */
  sha256?: string;
  /** For frames: the timestamp in the source media, as observed. Absent for still images. */
  timestampMs?: number;
  source?: string;
};

export type GateInput = {
  sql?: Sql;
  organizationId: string;
  brandId: string;
  gate: string;
  subject: { type: string; id: string };
  description: string;
  /** Structured, minimized text context for the engine. Callers must not pass secrets or raw tenant data. */
  context: Record<string, unknown>;
  questions: GateQuestion[];
  evidence: GateEvidence[];
  /** Images in the order they are provided. Only sent when the active engine accepts images. */
  images?: DecisionImageInput[];
  /** Deterministic rejections, decided before this call. Any one rejects the subject without calling an engine. */
  deterministicRejections?: Array<{ rule: string; reason: string }>;
  /** The selection the caller already resolved. When absent, the gate resolves the workspace's active engine once. */
  selection?: EngineSelection;
  /** Transport routing for the JEV engine. Other engines ignore it. */
  routingPolicy?: JevRoutingPolicy;
  engines?: DecisionEngineRegistry;
};

export type GateResult = {
  action: PolicyOutcome;
  reason: string;
  engineCalled: boolean;
  engineId: EngineSelection["engineId"] | null;
  selectionSource: EngineSelection["source"] | "deterministic";
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  policyVersion: string;
  questionVersions: string[];
  /** Whether the engine run was written to the decision ledger (jev_runs and jev_answers). */
  lineagePersisted: boolean;
  /** Normalized answers from the engine, keyed by the caller's question key. Locally refused answers are included. */
  answers: Record<string, JevAnswer>;
  votes: Array<{ questionId: string; outcome: PolicyOutcome; reason: string }>;
  unresolved: Array<{ questionId: string; status: string; reason: string }>;
  evidence: GateEvidence[];
  imagesSent: number;
  imagesOmitted: number;
  latencyMs: number;
  usage?: DecisionUsage;
  failureKind?: string;
  gateRecordId: string | null;
  runId: string | null;
};

type GateOutcome = Omit<GateResult, "gateRecordId" | "evidence">;

export async function runEngineGate(input: GateInput): Promise<GateResult> {
  const started = Date.now();
  const gating = input.questions.filter((question) => question.gating !== false);
  const policies = gating.map((question) => ({
    questionId: question.spec.id,
    policy: policyForQuestion(question.spec),
  }));
  const questionVersions = input.questions.map((question) => `${question.spec.id}@${question.spec.version}`);
  const policyVersion = policies.map((entry) => `${entry.questionId}@${entry.policy.version}`).join(",");

  // 1. Deterministic rejection: decided by code, before any engine. No engine call, no override.
  if (input.deterministicRejections && input.deterministicRejections.length > 0) {
    const reason = input.deterministicRejections.map((rejection) => `${rejection.rule}: ${rejection.reason}`).join("; ");
    return finish(input, {
      action: "REJECT",
      reason: `Deterministic rejection: ${reason}`,
      engineCalled: false,
      engineId: null,
      selectionSource: "deterministic",
      provider: null,
      model: null,
      requestedModel: null,
      returnedModel: null,
      policyVersion,
      questionVersions,
      lineagePersisted: false,
      answers: {},
      votes: [],
      unresolved: [],
      imagesSent: 0,
      imagesOmitted: input.images?.length ?? 0,
      latencyMs: Date.now() - started,
      runId: null,
    });
  }

  // 2. One selection, one engine.
  const selection = input.selection ?? (await resolveActiveEngine(input.sql, input.organizationId));
  const engineAcceptsImages = selection.engineId === "openai-decisions";
  const images = engineAcceptsImages ? (input.images ?? []) : [];

  // 3. Questions that need an image are refused locally when the engine cannot see one, or when none was supplied.
  const localAnswers: Record<string, JevAnswer> = {};
  const answerable: GateQuestion[] = [];
  for (const question of input.questions) {
    if (!question.needsImage) {
      answerable.push(question);
      continue;
    }
    if (!engineAcceptsImages) {
      localAnswers[question.key] = localRefusal(question, selection.engineId, "unsupported",
        `${selection.engineId} cannot judge images, and this question needs one. Routed to human review.`);
      continue;
    }
    if (images.length === 0) {
      localAnswers[question.key] = localRefusal(question, selection.engineId, "abstain_insufficient_evidence",
        "This question needs an image and none was supplied.");
      continue;
    }
    answerable.push(question);
  }

  // 4. At most one engine call, carrying every answerable question.
  let engineAnswers: Record<string, JevAnswer> = {};
  let runId: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let lineagePersisted = false;
  let returnedModel: string | null = null;
  let requestedModel: string | null = null;
  let usage: DecisionUsage | undefined;
  let failureKind: string | undefined;
  let engineCalled = false;
  let imagesSent = 0;

  if (answerable.length > 0) {
    engineCalled = true;
    // Images are transmitted only when a question needs one. A text-only gate never sends them.
    const needsImage = answerable.some((question) => question.needsImage);
    const request: DecisionRequest = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      state: {
        description: input.description,
        availableEvidence: input.evidence.map((item) => item.name),
        ...input.context,
      },
      questions: Object.fromEntries(answerable.map((question) => [question.key, question.spec])),
      images: needsImage ? images : [],
      imagePolicy: needsImage ? "required" : "optional",
      routingPolicy: input.routingPolicy,
    };
    try {
      const dispatched = await decideWithActiveEngine({
        sql: input.sql,
        request,
        engines: input.engines,
        selection,
      });
      engineAnswers = dispatched.answers;
      runId = dispatched.runId;
      provider = dispatched.provider;
      model = dispatched.model;
      lineagePersisted = dispatched.persisted;
      requestedModel = dispatched.requestedModel;
      returnedModel = dispatched.returnedModel;
      usage = dispatched.usage;
      failureKind = dispatched.failure?.kind;
      imagesSent = dispatched.imageCount;
    } catch (error) {
      // An engine that throws is a provider failure. The gate fails closed, and no other engine is called.
      const message = error instanceof Error ? error.message : String(error);
      engineAnswers = abstainAll(request, {
        status: "provider_error",
        reason: `The ${selection.engineId} engine failed: ${message}`,
        model: "none",
        provider: selection.engineId,
      });
      failureKind = "provider_unavailable";
      // The images were in the request when it was sent, so they count as sent.
      imagesSent = images.length;
    }
  }

  // 5. Each question under its own policy. Local refusals are unresolved answers, so they resolve to review.
  const answers = { ...engineAnswers, ...localAnswers };
  const evaluation = evaluateQuestionPolicies(answers, policies);
  const action = evaluation.outcome;

  return finish(input, {
    action,
    reason: buildReason(action, evaluation, failureKind, selection),
    engineCalled,
    engineId: selection.engineId,
    selectionSource: selection.source,
    provider,
    model,
    requestedModel,
    returnedModel,
    policyVersion,
    questionVersions,
    lineagePersisted,
    answers,
    votes: evaluation.votes.map((vote) => ({ questionId: vote.questionId, outcome: vote.outcome, reason: vote.reason })),
    unresolved: evaluation.unresolved.map((item) => ({ questionId: item.questionId, status: item.status, reason: item.reason })),
    imagesSent,
    imagesOmitted: (input.images?.length ?? 0) - imagesSent,
    latencyMs: Date.now() - started,
    usage,
    failureKind,
    runId,
  });
}

function localRefusal(
  question: GateQuestion,
  engineId: string,
  status: "unsupported" | "abstain_insufficient_evidence",
  reason: string,
): JevAnswer {
  return {
    questionId: question.spec.id,
    questionVersion: question.spec.version,
    type: question.spec.type,
    model: "none",
    provider: engineId,
    status,
    evidenceRefs: [],
    abstainReason: reason,
    evaluatedAt: new Date().toISOString(),
  };
}

function buildReason(
  action: PolicyOutcome,
  evaluation: ReturnType<typeof evaluateQuestionPolicies>,
  failureKind: string | undefined,
  selection: EngineSelection,
): string {
  const parts: string[] = [`Engine ${selection.engineId} (${selection.source}).`];
  if (evaluation.votes.length === 0 && evaluation.unresolved.length === 0) {
    parts.push("No gating question was asked, so nothing can be approved automatically.");
  }
  if (failureKind) parts.push(`Provider failure: ${failureKind}.`);
  const blocking = evaluation.votes.filter((vote) => vote.outcome !== "AUTO_APPROVE");
  for (const vote of blocking.slice(0, 3)) parts.push(`${vote.questionId}: ${vote.outcome}, ${vote.reason}`);
  for (const item of evaluation.unresolved.slice(0, 3)) parts.push(`${item.questionId}: ${item.status}, ${item.reason}`);
  if (action === "AUTO_APPROVE") parts.push("Every question passed its policy.");
  return parts.join(" ");
}

async function finish(input: GateInput, outcome: GateOutcome): Promise<GateResult> {
  const full: GateResult = { ...outcome, evidence: input.evidence, gateRecordId: null };
  if (!input.sql) return full;
  const id = randomUUID();
  try {
    await input.sql`
      insert into decision_gate_records (
        id, organization_id, brand_id, gate, subject_type, subject_id, engine_called, engine_id, adapter_version,
        requested_model, returned_model, run_id, policy_version, question_versions, evidence, votes, unresolved,
        deterministic_rejections, action, reason, latency_ms, usage, failure_kind
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.gate}, ${input.subject.type}, ${input.subject.id},
        ${full.engineCalled}, ${full.engineId}, null, ${full.requestedModel}, ${full.returnedModel}, ${full.runId},
        ${full.policyVersion}, ${JSON.stringify(full.questionVersions)}, ${JSON.stringify(full.evidence)},
        ${JSON.stringify(full.votes)}, ${JSON.stringify(full.unresolved)},
        ${JSON.stringify(input.deterministicRejections ?? [])}, ${full.action}, ${full.reason}, ${full.latencyMs},
        ${full.usage ? JSON.stringify(full.usage) : null}, ${full.failureKind ?? null}
      )
    `;
    return { ...full, gateRecordId: id };
  } catch (error) {
    // The decision stands even if its record cannot be written. The caller sees no record id.
    console.warn("[decisions] Failed to persist gate record:", error instanceof Error ? error.message : error);
    return full;
  }
}
