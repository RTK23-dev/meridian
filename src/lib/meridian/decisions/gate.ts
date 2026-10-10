/**
 * The engine gate: one path for every production decision that needs contextual judgment.
 *
 * Order of evaluation, and why:
 * 1. Deterministic rejections come first. Budget, source permission, media integrity, schema, provider capability,
 *    and rights are checked by code. If one fails, the gate rejects and no engine is called. An engine can never
 *    override a deterministic rejection.
 * 2. The active engine is resolved once. Only that engine is ever called. There is no fallback to the other engine and no
 *    second opinion from it.
 * 3. Each question receives only the evidence in its own scope (`GateQuestion.evidenceScope`). Questions with the same scope
 *    and the same image need share one call to the active engine. Each call carries only its group's evidence. A question
 *    whose own requirements are not met by its scope abstains without a call. If a call fails as a whole, the later groups
 *    are not sent, and their questions are recorded as not sent.
 * 4. Each question is evaluated under its own policy, from the registry. Its answer is a vote only when the policy allows it,
 *    and nothing approves on a question that has no policy, no evidence in scope, or an unresolved answer. A refused,
 *    unsupported, malformed, or missing answer, or a provider failure, takes the question's unresolved outcome.
 * 5. The decision is persisted with its versions, engine, models, evidence, votes, action, reason, latency, and usage. Each
 *    vote and each unresolved item records its scope, model, and run id.
 *
 * Scope vocabulary. A scope names evidence items (`GateEvidence.name`). The scope name `IMAGE_SCOPE` stands for every image
 * item. A question's requirements (`spec.evidenceRequirements`) are met only by the names in its own scope.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { JevAnswer, JevQuestionSpec, JevRoutingPolicy } from "../jev/types.ts";
import { checkEvidenceSufficiency } from "../jev/client.ts";
import { decideWithActiveEngine, type DecisionEngineRegistry } from "./dispatcher.ts";
import { calibrationStatusOf, evaluateQuestionPolicies, policyForQuestion, policyVersionOf, type CalibrationStatus, type PolicyOutcome } from "./policy.ts";
import { resolveActiveEngine, type EngineSelection } from "./selection.ts";
import { abstainAll, type DecisionImageInput, type DecisionRequest, type DecisionUsage } from "./types.ts";

/** The scope name of image evidence. A question scoped to it receives every image item the gate was given. */
export const IMAGE_SCOPE = "image";

export type GateQuestion = {
  /** The key the caller uses for this question. Answers are keyed by it. */
  key: string;
  spec: JevQuestionSpec;
  /** True when the question cannot be answered from text alone. */
  needsImage: boolean;
  /**
   * Why this question is refused locally, with which status. The caller sets it when it knows the reason, for example that
   * perception evidence is missing. A question with this set is never sent to an engine.
   */
  localRefusal?: { status: "unsupported" | "abstain_insufficient_evidence"; reason: string };
  /**
   * False for analysis questions: they are answered and recorded, but they do not decide the action. Default true.
   * A gate with no gating question cannot approve anything, so its action is review.
   */
  gating?: boolean;
  /**
   * The evidence names this question may receive: GateEvidence.name values, or IMAGE_SCOPE for every image item. The question
   * sees only the items in this scope. Questions with an identical scope and image need share one engine call. A question
   * with no scope receives no evidence, so it can be answered only when its spec declares no requirements.
   */
  evidenceScope?: readonly string[];
};

/** One piece of evidence the caller actually provided. Recorded so a reviewer can see exactly what was judged. */
export type GateEvidence = {
  kind: "text" | "image";
  /** Stable name. Scopes select evidence by this name. */
  name: string;
  /** Hash of the content, for images and long text. Never the content itself. */
  sha256?: string;
  /** For frames: the timestamp in the source media, as observed. Absent for still images. */
  timestampMs?: number;
  source?: string;
};

/**
 * Evidence as the caller supplies it. `content` is what a question whose scope holds this item receives, as `state.evidence`.
 * The content is never recorded: only the GateEvidence fields are.
 */
export type GateEvidenceInput = GateEvidence & { content?: unknown };

/** An image, tied to the image evidence item it depicts. It reaches only questions whose scope holds that item. */
export type GateImage = DecisionImageInput & {
  /** The `name` of the image evidence item this image depicts. */
  evidenceName: string;
};

export type GateInput = {
  sql?: Sql;
  organizationId: string;
  brandId: string;
  gate: string;
  subject: { type: string; id: string };
  /** Shared by every question. It describes the subject, and it carries no evidence. Evidence content goes in `evidence`. */
  description: string;
  questions: GateQuestion[];
  evidence: GateEvidenceInput[];
  /** Images, each tied to its evidence item. Only sent when the active engine accepts images, and then only in scope. */
  images?: GateImage[];
  /** Deterministic rejections, decided before this call. Any one rejects the subject without calling an engine. */
  deterministicRejections?: Array<{ rule: string; reason: string }>;
  /** The selection the caller already resolved. When absent, the gate resolves the workspace's active engine once. */
  selection?: EngineSelection;
  /** Transport routing for the JEV engine. Other engines ignore it. */
  routingPolicy?: JevRoutingPolicy;
  engines?: DecisionEngineRegistry;
};

/** One call to the active engine, made for one evidence scope. A call that was not sent is recorded with `skipped`. */
export type GateCall = {
  scope: string[];
  questionKeys: string[];
  engineCalled: boolean;
  skipped: boolean;
  runId: string | null;
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  imagesSent: number;
  failureKind?: string;
};

/** Where a vote or an unresolved item came from: its scope, and the call and model that answered it. */
export type GateProvenance = {
  scope: string[];
  model: string | null;
  runId: string | null;
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
  /** Whether every engine run was written to the decision ledger (jev_runs and jev_answers). */
  lineagePersisted: boolean;
  /** Normalized answers from the engine, keyed by the caller's question key. Locally refused answers are included. */
  answers: Record<string, JevAnswer>;
  votes: Array<GateProvenance & { questionId: string; outcome: PolicyOutcome; reason: string; calibrationStatus: CalibrationStatus }>;
  unresolved: Array<GateProvenance & { questionId: string; status: string; reason: string; calibrationStatus: CalibrationStatus }>;
  evidence: GateEvidence[];
  /** One entry per evidence scope: the engine calls the gate made, and the calls it did not send. */
  calls: GateCall[];
  /** The first engine run's id. Each vote and unresolved item carries its own run id. */
  runId: string | null;
  imagesSent: number;
  imagesOmitted: number;
  latencyMs: number;
  usage?: DecisionUsage;
  failureKind?: string;
  gateRecordId: string | null;
};

type GateOutcome = Omit<GateResult, "gateRecordId" | "evidence">;

type PlannedGroup = {
  scope: string[];
  needsImage: boolean;
  items: GateEvidenceInput[];
  available: string[];
  questions: GateQuestion[];
};

export async function runEngineGate(input: GateInput): Promise<GateResult> {
  const started = Date.now();
  const gating = input.questions.filter((question) => question.gating !== false);
  const questionVersions = input.questions.map((question) => `${question.spec.id}@${question.spec.version}`);
  // A policy version already names its question (`question-id@version`), so it is not prefixed again.
  const policyVersion = gating.map((question) => policyVersionOf(question.spec)).join(",");

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
      calls: [],
      imagesSent: 0,
      imagesOmitted: input.images?.length ?? 0,
      latencyMs: Date.now() - started,
      runId: null,
    });
  }

  // 2. One selection. Only the engine it names is ever called.
  const selection = input.selection ?? (await resolveActiveEngine(input.sql, input.organizationId));
  const engineAcceptsImages = selection.engineId === "openai-decisions";
  const images = engineAcceptsImages ? (input.images ?? []) : [];

  // 3. Plan. Each question gets its own scope, is checked against it, and is grouped with the questions that share it.
  const localAnswers: Record<string, JevAnswer> = {};
  const scopeOfKey = new Map<string, { scope: string[]; present: boolean }>();
  const groups = new Map<string, PlannedGroup>();
  for (const question of input.questions) {
    const scope = uniqueSorted(question.evidenceScope ?? []);
    const items = input.evidence.filter((item) => scope.some((entry) => matchesScope(item, entry)));
    scopeOfKey.set(question.key, { scope, present: items.length > 0 });

    if (question.localRefusal) {
      localAnswers[question.key] = refusalAnswer(question, selection.engineId, question.localRefusal.status, question.localRefusal.reason);
      continue;
    }
    if (question.needsImage) {
      if (!engineAcceptsImages) {
        localAnswers[question.key] = refusalAnswer(
          question,
          selection.engineId,
          "unsupported",
          `${selection.engineId} cannot judge images, and this question needs one. Routed to human review.`,
        );
        continue;
      }
      const sees = images.some((image) => items.some((item) => item.kind === "image" && item.name === image.evidenceName));
      if (!sees) {
        localAnswers[question.key] = refusalAnswer(
          question,
          selection.engineId,
          "abstain_insufficient_evidence",
          "This question needs an image in its evidence scope, and none was supplied.",
        );
        continue;
      }
    }
    const sufficiency = checkEvidenceSufficiency(question.spec, availableEvidenceOf(items));
    if (!sufficiency.sufficient) {
      localAnswers[question.key] = refusalAnswer(
        question,
        selection.engineId,
        "abstain_insufficient_evidence",
        `Missing required evidence: ${sufficiency.missing.join(", ")}.`,
      );
      continue;
    }
    const groupKey = JSON.stringify({ scope, needsImage: question.needsImage });
    let group = groups.get(groupKey);
    if (!group) {
      group = { scope, needsImage: question.needsImage, items, available: availableEvidenceOf(items), questions: [] };
      groups.set(groupKey, group);
    }
    group.questions.push(question);
  }

  // 4. One call per group, to the active engine. A whole-call failure stops the later groups, which are not sent.
  const answers: Record<string, JevAnswer> = {};
  const calls: GateCall[] = [];
  let stoppedBy: string | null = null;
  let imagesSent = 0;
  let usage: DecisionUsage | undefined;
  let lineagePersisted = true;
  for (const group of groups.values()) {
    const groupImages = group.needsImage
      ? images.filter((image) => group.items.some((item) => item.kind === "image" && item.name === image.evidenceName))
      : [];
    const call: GateCall = {
      scope: group.scope,
      questionKeys: group.questions.map((question) => question.key),
      engineCalled: false,
      skipped: false,
      runId: null,
      provider: null,
      model: null,
      requestedModel: null,
      returnedModel: null,
      imagesSent: 0,
    };
    calls.push(call);
    if (stoppedBy) {
      call.skipped = true;
      call.failureKind = stoppedBy;
      for (const question of group.questions) {
        answers[question.key] = refusalAnswer(
          question,
          selection.engineId,
          "provider_error",
          `Not sent: the ${selection.engineId} engine failed earlier in this decision (${stoppedBy}).`,
        );
      }
      continue;
    }

    const request: DecisionRequest = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      state: {
        description: input.description,
        availableEvidence: group.available,
        evidence: contentOf(group.items),
      },
      questions: Object.fromEntries(group.questions.map((question) => [question.key, question.spec])),
      images: groupImages.map((image) => ({ bytes: image.bytes, evidenceRef: image.evidenceRef, label: image.label })),
      imagePolicy: group.needsImage ? "required" : "optional",
      routingPolicy: input.routingPolicy,
    };
    call.engineCalled = true;
    try {
      const dispatched = await decideWithActiveEngine({ sql: input.sql, request, engines: input.engines, selection });
      for (const question of group.questions) {
        const answer = dispatched.answers[question.key];
        if (answer) answers[question.key] = answer;
      }
      call.runId = dispatched.runId;
      call.provider = dispatched.provider;
      call.model = dispatched.model;
      call.requestedModel = dispatched.requestedModel;
      call.returnedModel = dispatched.returnedModel;
      call.imagesSent = dispatched.imageCount;
      call.failureKind = dispatched.failure?.kind;
      imagesSent += dispatched.imageCount;
      usage = addUsage(usage, dispatched.usage);
      lineagePersisted = lineagePersisted && dispatched.persisted;
      if (dispatched.failure) stoppedBy = dispatched.failure.kind;
    } catch (error) {
      // An engine that throws is a provider failure. The gate fails closed, and no other engine is called.
      const message = error instanceof Error ? error.message : String(error);
      const failed = abstainAll(request, {
        status: "provider_error",
        reason: `The ${selection.engineId} engine failed: ${message}`,
        model: "none",
        provider: selection.engineId,
      });
      for (const question of group.questions) answers[question.key] = failed[question.key]!;
      call.failureKind = "provider_unavailable";
      // The images were in the request when it was sent, so they count as sent.
      call.imagesSent = groupImages.length;
      imagesSent += groupImages.length;
      lineagePersisted = false;
      stoppedBy = "provider_unavailable";
    }
  }

  // 5. Each question under its own policy. Local refusals are unresolved answers, so they resolve to review.
  const allAnswers: Record<string, JevAnswer> = { ...answers, ...localAnswers };
  const evaluation = evaluateQuestionPolicies(
    allAnswers,
    gating.map((question) => ({
      questionId: question.spec.id,
      policy: policyForQuestion(question.spec),
      scopePresent: scopeOfKey.get(question.key)?.present ?? false,
    })),
  );

  // 6. Provenance: every vote and unresolved item names its scope, its model, and its run.
  const keyOfQuestionId = new Map(input.questions.map((question) => [question.spec.id, question.key]));
  const provenanceOf = (questionId: string): GateProvenance => {
    const key = keyOfQuestionId.get(questionId);
    const call = key === undefined ? undefined : calls.find((entry) => entry.questionKeys.includes(key));
    return {
      scope: key === undefined ? [] : (scopeOfKey.get(key)?.scope ?? []),
      model: call?.model ?? null,
      runId: call?.runId ?? null,
    };
  };
  const allAnswerList = Object.values(allAnswers);
  const calledCalls = calls.filter((call) => call.engineCalled);
  const firstFailure = calledCalls.find((call) => call.failureKind)?.failureKind;

  return finish(input, {
    action: evaluation.outcome,
    reason: buildReason(evaluation.outcome, evaluation, firstFailure, selection, calledCalls.length),
    engineCalled: calledCalls.length > 0,
    engineId: selection.engineId,
    selectionSource: selection.source,
    provider: uniqueJoin(calledCalls.map((call) => call.provider)),
    model: uniqueJoin(calledCalls.map((call) => call.model)),
    requestedModel: uniqueJoin(calledCalls.map((call) => call.requestedModel)),
    returnedModel: uniqueJoin(calledCalls.map((call) => call.returnedModel)),
    policyVersion,
    questionVersions,
    lineagePersisted: calledCalls.length > 0 && lineagePersisted,
    answers: allAnswers,
    votes: evaluation.votes.map((vote) => ({
      questionId: vote.questionId,
      outcome: vote.outcome,
      reason: vote.reason,
      calibrationStatus: vote.calibrationStatus,
      ...provenanceOf(vote.questionId),
    })),
    unresolved: evaluation.unresolved.map((item) => {
      const answer = allAnswerList.find((entry) => entry.questionId === item.questionId);
      return {
        questionId: item.questionId,
        status: item.status,
        reason: item.reason,
        calibrationStatus: answer ? calibrationStatusOf(answer) : "not_applicable",
        ...provenanceOf(item.questionId),
      };
    }),
    calls,
    runId: calledCalls.find((call) => call.runId)?.runId ?? null,
    imagesSent,
    imagesOmitted: (input.images?.length ?? 0) - imagesSent,
    latencyMs: Date.now() - started,
    usage,
    failureKind: firstFailure,
  });
}

/** The answer a question gets when the gate refuses it without asking the engine. */
function refusalAnswer(
  question: GateQuestion,
  engineId: string,
  status: "unsupported" | "abstain_insufficient_evidence" | "provider_error",
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

/** A scope entry matches an item by name, or matches every image item for the image scope. */
function matchesScope(item: GateEvidenceInput, entry: string): boolean {
  return item.name === entry || (entry === IMAGE_SCOPE && item.kind === "image");
}

/**
 * The names a requirement can be met by. Each item contributes its name. Image items also contribute the image scope name, so
 * a question that requires an image is met by the image evidence its scope holds, and by nothing else.
 */
function availableEvidenceOf(items: GateEvidenceInput[]): string[] {
  const names = items.map((item) => item.name);
  if (items.some((item) => item.kind === "image")) names.push(IMAGE_SCOPE);
  return [...new Set(names)];
}

/** The content of the items in one group, keyed by evidence name. Items without content contribute nothing. */
function contentOf(items: GateEvidenceInput[]): Record<string, unknown> {
  return Object.fromEntries(items.filter((item) => item.content !== undefined).map((item) => [item.name, item.content]));
}

function recordOf(item: GateEvidenceInput): GateEvidence {
  const record: GateEvidence = { kind: item.kind, name: item.name };
  if (item.sha256 !== undefined) record.sha256 = item.sha256;
  if (item.timestampMs !== undefined) record.timestampMs = item.timestampMs;
  if (item.source !== undefined) record.source = item.source;
  return record;
}

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

function uniqueJoin(values: Array<string | null | undefined>): string | null {
  const list = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
  return list.length > 0 ? list.join(", ") : null;
}

function addUsage(total: DecisionUsage | undefined, next: DecisionUsage | undefined): DecisionUsage | undefined {
  if (!next) return total;
  const sum: DecisionUsage = { ...(total ?? {}) };
  for (const key of Object.keys(next) as Array<keyof DecisionUsage>) {
    const value = next[key];
    if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}

function buildReason(
  action: PolicyOutcome,
  evaluation: ReturnType<typeof evaluateQuestionPolicies>,
  failureKind: string | undefined,
  selection: EngineSelection,
  callCount: number,
): string {
  const parts: string[] = [`Engine ${selection.engineId} (${selection.source}).`];
  if (callCount > 1) parts.push(`${callCount} engine calls, one per evidence scope.`);
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
  const full: GateResult = { ...outcome, evidence: input.evidence.map(recordOf), gateRecordId: null };
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
