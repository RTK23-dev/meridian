/**
 * Quality judgment for generated images and videos. The studio and the durable production materializer both judge a
 * creative with these functions, so a judgment is made from the stored bytes and the brand's own data, in one place.
 *
 * Two kinds of check, with different authority:
 * - Local, deterministic checks decide what they can decide from measured facts and literal rules: a prohibited phrase
 *   in the copy, an avoided word, a measured logo or palette mismatch, exact and near duplicates, competitor overlap,
 *   and publishing readiness. A local REJECT is final: the engine is not asked to override it.
 * - Semantic checks are the active decision engine's judgment, asked once through the engine gate: brand fit, opportunity
 *   fit, claim compliance on the copy, and, for images, visual quality and product visibility. A semantic question
 *   that needs an image is refused when the engine cannot see one, and routes to human review.
 */
import type { Sql } from "../learning/store.ts";
import type { loadBrandContext } from "../context/load.ts";
import { decisionRecordFields } from "../jev/decision-record.ts";
import { loadAppliedPolicies } from "../jev/policy.ts";
import { CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { judgeMedia, rollupDecision, ENGINE_REPLACED_MEDIA_QUESTIONS, type MediaFacts } from "./features.ts";
import type { AccountSnapshot } from "../publishing/readiness.ts";
import { measureLogo, measurePalette } from "../vision/measure.ts";
import { runEngineGate, type GateEvidence, type GateQuestion } from "../decisions/gate.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { selectRepresentativeFrames, FRAME_SELECTION_VERSION } from "../decisions/frames.ts";
import type { DecisionImageInput } from "../decisions/types.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";

export type QcBrandContext = {
  brain: { positioning: string; valueProposition: string; tone: string; prohibitedClaims: string; wordsToAvoid: string };
  creatives: Array<{ origin: string; text: string }>;
};

export function qcBrandOf(loaded: Awaited<ReturnType<typeof loadBrandContext>>): QcBrandContext {
  return {
    brain: {
      positioning: loaded.brain.positioning,
      valueProposition: loaded.brain.valueProposition,
      tone: loaded.brain.tone,
      prohibitedClaims: loaded.brain.prohibitedClaims,
      wordsToAvoid: loaded.brain.wordsToAvoid,
    },
    creatives: loaded.creatives.map((item) => ({ origin: item.origin, text: item.text })),
  };
}

export async function visualFacts(sql: Sql, organizationId: string, brandId: string, bytes: Uint8Array) {
  const logos = await sql<{ body: string }>`
    select body from assets
    where brand_id = ${brandId} and organization_id = ${organizationId} and label = 'logo' and status = 'stored'
    order by created_at desc
    limit 1
  `;
  const colors = await sql<{ colors: string }>`
    select colors from brand_brains where brand_id = ${brandId} limit 1
  `;
  const logo = logos[0]?.body ? Buffer.from(logos[0].body, "base64") : null;
  const measuredLogo = measureLogo(logo, bytes);
  const measuredPalette = measurePalette(colors[0]?.colors ?? "", bytes);
  return { measuredLogo, measuredPalette };
}

export async function accountSnapshots(sql: Sql, organizationId: string): Promise<AccountSnapshot[]> {
  const rows = await sql<{ provider: string; status: string; account_id: string; permissions: string }>`
    select provider, status, account_id, permissions from provider_connections
    where organization_id = ${organizationId}
  `;
  return rows.map((row) => {
    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(row.permissions) as unknown;
      permissions = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      permissions = [];
    }
    return {
      provider: row.provider,
      status: row.status,
      accountId: row.account_id,
      permissions,
      pageId: "",
      destinationUrl: "",
    };
  });
}

export function competitorCopy(loaded: QcBrandContext): string[] {
  return loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text);
}

export function factsFor(
  loaded: QcBrandContext,
  input: Omit<MediaFacts, "positioning" | "tone" | "prohibited" | "wordsToAvoid" | "competitorTexts" | "ownTexts">,
): MediaFacts {
  return {
    ...input,
    positioning: `${loaded.brain.positioning}\n${loaded.brain.valueProposition}`,
    tone: loaded.brain.tone,
    prohibited: loaded.brain.prohibitedClaims,
    wordsToAvoid: loaded.brain.wordsToAvoid,
    competitorTexts: loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text),
    ownTexts: loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text),
  };
}

/** Visual evidence the engine may see: the images, in order, and a record of exactly what each one was. */
export type VisualEvidence = {
  images: DecisionImageInput[];
  evidence: GateEvidence[];
  /** For video: how representative frames were chosen and how many were omitted, by reason. */
  frames?: { version: string; provided: number; omitted: Record<string, number> };
};

export const NO_VISUAL_EVIDENCE: VisualEvidence = { images: [], evidence: [] };

export type CreativeJudgmentInput = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  facts: MediaFacts;
  /** Visual evidence the engine may see. Absent means no image or frame was provided. */
  visual?: VisualEvidence;
  engines?: DecisionEngineRegistry;
};

export type CreativeJudgment = {
  /** The outcome that governs the creative: the more severe of the local checks and the engine gate. */
  rollup: PolicyOutcome;
  /** The decision the creative points to: a local decision, or the gate record when the engine decided the outcome. */
  decisionId: string;
  gateRecordId: string | null;
  gateAction: PolicyOutcome;
  gateEngineCalled: boolean;
};

const SEVERITY: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

/** The semantic questions for a creative. Image questions are listed for every creative and are refused without images. */
export function creativeGateQuestions(): GateQuestion[] {
  const text = ["creative.brand_fit.v1", "creative.opportunity_fit.v1", "creative.claim_compliance.v1"];
  const visual = ["creative.visual_quality.v1", "creative.product_visible.v1"];
  return [
    ...text.map((id) => ({ key: id, spec: CREATIVE_QUESTIONS[id]!, needsImage: false })),
    ...visual.map((id) => ({ key: id, spec: CREATIVE_QUESTIONS[id]!, needsImage: true })),
  ];
}

/** The minimized context sent to the engine. Competitor text and the generation prompt are not sent. */
export function creativeGateContext(facts: MediaFacts): Record<string, unknown> {
  return {
    creative: {
      kind: facts.kind,
      copy: facts.copy,
      transcript: facts.transcript || undefined,
      productName: facts.productName,
      angle: facts.angle,
    },
    brand: {
      positioning: facts.positioning,
      tone: facts.tone,
      prohibitedClaims: facts.prohibited,
    },
  };
}

function creativeTextEvidence(facts: MediaFacts): GateEvidence[] {
  const items: GateEvidence[] = [];
  if (facts.copy.trim()) items.push({ kind: "text", name: "creative_copy", source: "creative_records" });
  if (facts.transcript.trim()) items.push({ kind: "text", name: "transcript", source: "assets" });
  if (facts.positioning.trim()) items.push({ kind: "text", name: "brand_positioning", source: "brand_brain" });
  if (facts.prohibited.trim()) items.push({ kind: "text", name: "brand_prohibited_claims", source: "brand_brain" });
  if (facts.angle.trim()) items.push({ kind: "text", name: "opportunity_angle", source: "opportunity" });
  if (facts.productName.trim()) items.push({ kind: "text", name: "product_name", source: "products" });
  return items;
}

export async function writeJudgment(sql: Sql, input: CreativeJudgmentInput): Promise<CreativeJudgment> {
  const visual = input.visual ?? NO_VISUAL_EVIDENCE;
  const policies = await loadAppliedPolicies(sql, input.organizationId);
  // Local checks decide only the deterministic questions. The lexical brand and opportunity checks are not authorities.
  const local = judgeMedia(input.facts, policies).filter((decision) => !ENGINE_REPLACED_MEDIA_QUESTIONS.has(decision.questionId));
  const localRollup = rollupDecision(local);
  const deterministicRejections = local
    .filter((decision) => decision.decision === "REJECT")
    .map((decision) => ({ rule: decision.questionId, reason: decision.reasons[0] ?? "A local check rejected this creative." }));

  const gate = await runEngineGate({
    sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "creative_qa",
    subject: { type: "creative", id: input.creativeId },
    description: `${input.facts.kind === "video" ? "Video" : "Image"} creative. Judge only the evidence provided.`,
    context: {
      ...creativeGateContext(input.facts),
      ...(visual.frames ? { frameSelection: visual.frames } : {}),
    },
    questions: creativeGateQuestions(),
    evidence: [...creativeTextEvidence(input.facts), ...visual.evidence],
    images: visual.images,
    deterministicRejections,
    engines: input.engines,
  });

  const gateIsMoreSevere = SEVERITY[gate.action] > SEVERITY[localRollup];
  const rollup: PolicyOutcome = gateIsMoreSevere ? gate.action : localRollup;
  let pointed = "";
  for (const decision of local) {
    // Deterministic per creative and question, so a retried judgment cannot record the same decision twice.
    const id = `${input.creativeId}:${decision.questionId}`;
    if (!pointed && decision.decision === rollup) pointed = id;
    const record = decisionRecordFields(decision);
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
        input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
        answer, schema_version, policy_version, calibration_version, decision_fingerprint, outcome_digest
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, ${decision.questionId},
        ${decision.questionVersion}, 'creative', ${input.creativeId}, ${JSON.stringify(decision.features)},
        ${JSON.stringify(decision.evidence)}, ${decision.probability}, ${decision.confidence},
        ${JSON.stringify(decision.policy)}, ${decision.decision}, ${JSON.stringify(decision.reasons)},
        ${decision.provider}, ${decision.modelVersion},
        ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""},
        ${record.decisionFingerprint}, ${record.outcomeDigest}
      )
      on conflict (id) do nothing
    `;
  }
  return {
    rollup,
    decisionId: (gateIsMoreSevere ? gate.gateRecordId : pointed) || gate.gateRecordId || "",
    gateRecordId: gate.gateRecordId,
    gateAction: gate.action,
    gateEngineCalled: gate.engineCalled,
  };
}

/** The image of a generated still. The bytes are the verified stored artifact, already checked by the caller. */
export function generatedImageVisual(bytes: Uint8Array, sha256: string): VisualEvidence {
  return {
    images: [{ bytes, label: "Generated image" }],
    evidence: [{ kind: "image", name: "generated_image", sha256, source: "storage_objects" }],
  };
}

/** The sql LIKE pattern for the frames stored beside a video container. */
export function frameLike(storageKey: string): string {
  return `${storageKey.replace(/[\\%_]/g, (char) => `\\${char}`)}.frame.%`;
}

/**
 * The frames of a stored video that the engine may see. Stored frames are PNGs found in the container, and they carry no
 * timestamp, so the selector omits them all and nothing is sent. The omission is recorded, not hidden.
 */
export async function videoVisualEvidence(sql: Sql, organizationId: string, brandId: string, storageKey: string): Promise<VisualEvidence> {
  if (!storageKey || storageKey.startsWith("pending/")) return NO_VISUAL_EVIDENCE;
  const rows = await sql<{ storage_key: string; body: string }>`
    select storage_key, body from asset_blobs
    where organization_id = ${organizationId} and brand_id = ${brandId}
      and storage_key like ${frameLike(storageKey)} escape '\\'
    order by storage_key asc
  `;
  const selection = selectRepresentativeFrames(
    rows.map((row) => ({ id: row.storage_key, bytes: new Uint8Array(Buffer.from(row.body, "base64")), timestampMs: null })),
  );
  const omitted: Record<string, number> = {};
  for (const item of selection.omitted) omitted[item.reason] = (omitted[item.reason] ?? 0) + 1;
  return {
    images: selection.frames.map((frame) => ({
      bytes: frame.bytes,
      label: `Frame at ${frame.timestampMs}ms (${frame.role})`,
      evidenceRef: { field: "scene", location: { startMs: frame.timestampMs, frameId: frame.id } },
    })),
    evidence: selection.frames.map((frame) => ({
      kind: "image" as const,
      name: frame.id,
      sha256: frame.sha256,
      timestampMs: frame.timestampMs,
      source: "asset_blobs",
    })),
    frames: { version: FRAME_SELECTION_VERSION, provided: selection.frames.length, omitted },
  };
}

