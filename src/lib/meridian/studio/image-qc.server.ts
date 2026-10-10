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
import { groundedPerceptionText, runPerception, selectPerceptionProvider, type PerceptionInputMedia, type PerceptionRunOutcome } from "../perception/run.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionMediaKind } from "../perception/types.ts";
import { EVIDENCE_CONTRACTS, checkEvidenceContract, contractEvidenceLines, type EvidenceContract } from "../perception/contracts.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { selectRepresentativeFrames, sha256Hex } from "../decisions/frames.ts";
import { sampleVideoFrames, type FrameExtractor } from "../video/sample-frames.ts";
import { resolveActiveEngine, type EngineSelection } from "../decisions/selection.ts";
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

/** A piece of media a judgment may use. Its timestamp is the real one for a video frame, and null for a still. */
export type VisualMedia = {
  id: string;
  bytes: Uint8Array;
  timestampMs: number | null;
  label: string;
  source: string;
};

/**
 * What visual evidence exists, and how much of the creative it covers. A video is never described as inspected in full:
 * the coverage says how many of its sampled frames were offered and how many were analysed.
 */
export type VisualCoverage = {
  scope: "still_image" | "sampled_frames";
  offered: number;
  analysed: number;
  durationMs: number | null;
  note: string;
  /** Why there is no media, when there is none. */
  unavailable?: string;
};

export type VisualEvidence = {
  kind: PerceptionMediaKind;
  media: VisualMedia[];
  coverage: VisualCoverage;
};

export const NO_VISUAL_EVIDENCE: VisualEvidence = {
  kind: "image",
  media: [],
  coverage: { scope: "still_image", offered: 0, analysed: 0, durationMs: null, note: "No image was available for this creative.", unavailable: "no_media" },
};

export type CreativeJudgmentInput = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  facts: MediaFacts;
  /** Visual evidence. Absent means no image or frame was available. */
  visual?: VisualEvidence;
  /** The engine the caller resolved. When absent, it is resolved here, once. */
  selection?: EngineSelection;
  /**
   * The perception provider used when the engine cannot see images. Absent means the configured provider is used; null means
   * none is available. The caller passes null when it has checked the provider is not ready, so no frame is sampled for it.
   */
  perception?: MultimodalPerceptionProvider | null;
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
  /** The perception run, when one was made. Absent when the engine received the media itself. */
  perceptionRunId: string | null;
};

const SEVERITY: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

/** The contract lines for every contract, from one perception run. Unknown facts appear as `unknown`. */
function contractLinesFor(run: PerceptionRunOutcome): Record<string, string[]> {
  if (run.status !== "observed") return {};
  const provenance = `${run.providerId} ${run.model} (prompt ${run.promptVersion})`;
  const label = (observation: MediaObservation) => {
    const media = run.media.find((item) => item.id === observation.mediaId);
    const when = observation.timestampMs !== null ? `at ${observation.timestampMs}ms` : "(still image)";
    return `${media?.label ?? observation.mediaId} ${when}, sha256 ${observation.sha256.slice(0, 12)}…`;
  };
  return Object.fromEntries(
    Object.values(EVIDENCE_CONTRACTS).map((contract: EvidenceContract) => [contract.id, contractEvidenceLines(contract, run.observations, label, provenance)]),
  );
}

/**
 * The semantic questions for a creative, for the engine that will judge them. OpenAI Decisions receives the visual questions
 * with their images. JEV receives a visual question as text only when the perception evidence satisfies that question's
 * contract for every analysed item. Otherwise the question is refused with the specific reason, and goes to review.
 */
export function creativeGateQuestionsFor(input: { engineSeesImages: boolean; perception?: PerceptionRunOutcome; hasMedia: boolean }): GateQuestion[] {
  const text = ["creative.brand_fit.v1", "creative.opportunity_fit.v1", "creative.claim_compliance.v1"].map((id) => ({
    key: id,
    spec: CREATIVE_QUESTIONS[id]!,
    needsImage: false,
  }));
  const visual = ["creative.visual_quality.v1", "creative.product_visible.v1"].map((id): GateQuestion => {
    const spec = CREATIVE_QUESTIONS[id]!;
    if (input.engineSeesImages) return { key: id, spec, needsImage: true };
    const contract = spec.perceptionEvidence ? EVIDENCE_CONTRACTS[spec.perceptionEvidence.contract] : undefined;
    if (!contract) {
      return { key: id, spec, needsImage: true, localRefusal: { status: "unsupported", reason: "JEV has no perception evidence contract for this question, so it cannot judge it from text. Routed to human review." } };
    }
    // The requirement names the evidence that is actually supplied: the perception observations, not the image bytes.
    const judgedFromText = { ...spec, evidenceRequirements: spec.evidenceRequirements.map((item) => (item === "image" ? "perception_observations" : item)) };
    const perception = input.perception;
    if (!input.hasMedia) {
      return { key: id, spec, needsImage: true, localRefusal: { status: "abstain_insufficient_evidence", reason: "No image or frame was available to perceive. Routed to human review." } };
    }
    if (!perception || perception.status !== "observed") {
      const why = perception ? `${perception.failureKind ?? "failed"}: ${perception.message ?? "no detail"}` : "perception was not run";
      return { key: id, spec, needsImage: true, localRefusal: { status: "abstain_insufficient_evidence", reason: `Perception produced no evidence (${why}). Routed to human review.` } };
    }
    const check = checkEvidenceContract(contract, perception.observations);
    if (!check.satisfied) {
      const unknown = check.missing.slice(0, 5).map((item) => `${item.field} (${item.mediaId})`).join(", ");
      return {
        key: id,
        spec: judgedFromText,
        needsImage: true,
        localRefusal: { status: "abstain_insufficient_evidence", reason: `${check.reason}${unknown ? ` Unknown: ${unknown}.` : ""} Routed to human review.` },
      };
    }
    return { key: id, spec: judgedFromText, needsImage: false };
  });
  return [...text, ...visual];
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
  const selection = input.selection ?? (await resolveActiveEngine(sql, input.organizationId));
  const policies = await loadAppliedPolicies(sql, input.organizationId);
  // Local checks decide only the deterministic questions. The lexical brand and opportunity checks are not authorities.
  const local = judgeMedia(input.facts, policies).filter((decision) => !ENGINE_REPLACED_MEDIA_QUESTIONS.has(decision.questionId));
  const localRollup = rollupDecision(local);
  const deterministicRejections = local
    .filter((decision) => decision.decision === "REJECT")
    .map((decision) => ({ rule: decision.questionId, reason: decision.reasons[0] ?? "A local check rejected this creative." }));

  // Routing. The media reaches the decision in exactly one of two ways, and never both.
  //  - OpenAI Decisions takes the frames or the image directly. Perception is not run: it would be a second analysis of the same media.
  //  - JEV cannot see images. Perception turns the media into grounded text for it. If perception is unavailable or fails,
  //    the visual questions stay unsupported and go to review. Nothing is sent to the other engine to make up the gap.
  let images: DecisionImageInput[] = [];
  let visualEvidence: GateEvidence[] = [];
  let perceptionEvidence: GateEvidence[] = [];
  let perceptionContext: Record<string, unknown> = { status: "not_needed" };
  let perceptionRunId: string | null = null;
  let perceptionOutcome: PerceptionRunOutcome | undefined;
  if (selection.engineId === "openai-decisions") {
    images = visual.media.map((item) => ({
      bytes: item.bytes,
      label: item.label,
      evidenceRef: { field: "scene", location: { startMs: item.timestampMs ?? undefined, frameId: item.id } },
    }));
    visualEvidence = visual.media.map((item) => ({
      kind: "image" as const,
      name: item.id,
      sha256: sha256Hex(item.bytes),
      timestampMs: item.timestampMs ?? undefined,
      source: item.source,
    }));
    perceptionContext = { status: "not_used", reason: "openai-decisions receives the media directly." };
  } else if (visual.media.length > 0) {
    const provider = input.perception === undefined ? selectPerceptionProvider().provider : input.perception;
    const run = await runPerception(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      subjectType: "creative",
      subjectId: input.creativeId,
      kind: visual.kind,
      media: visual.media.map((item): PerceptionInputMedia => ({ id: item.id, bytes: item.bytes, timestampMs: item.timestampMs, label: item.label })),
      durationMs: visual.coverage.durationMs,
      provider,
      providerReason: provider ? undefined : "No perception provider is ready.",
    });
    perceptionRunId = run.runId;
    perceptionOutcome = run;
    perceptionContext = {
      status: run.status,
      runId: run.runId,
      reused: run.reused,
      providerId: run.providerId,
      model: run.model,
      promptVersion: run.promptVersion,
      failureKind: run.failureKind ?? null,
      message: run.message ?? null,
      coverage: run.coverage,
      observations: groundedPerceptionText(run),
      contracts: contractLinesFor(run),
    };
    if (run.status === "observed") {
      perceptionEvidence = [
        { kind: "text", name: "perception_observations", source: `perception_run:${run.runId}` },
        ...run.media.map((item) => ({
          kind: "image" as const,
          name: item.id,
          sha256: item.sha256,
          timestampMs: item.timestampMs ?? undefined,
          source: `perception_run:${run.runId}`,
        })),
      ];
    }
  } else {
    perceptionContext = { status: "not_needed", reason: visual.coverage.note };
  }

  const gate = await runEngineGate({
    sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "creative_qa",
    subject: { type: "creative", id: input.creativeId },
    description: `${input.facts.kind === "video" ? "Video" : "Image"} creative. Judge only the evidence provided.`,
    context: {
      ...creativeGateContext(input.facts),
      visual: { kind: visual.kind, coverage: visual.coverage, engine: selection.engineId },
      perception: perceptionContext,
    },
    questions: creativeGateQuestionsFor({ engineSeesImages: selection.engineId === "openai-decisions", perception: perceptionOutcome, hasMedia: visual.media.length > 0 }),
    evidence: [...creativeTextEvidence(input.facts), ...visualEvidence, ...perceptionEvidence],
    images,
    deterministicRejections,
    selection,
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
    perceptionRunId,
  };
}

/** The image of a generated still. The bytes are the verified stored artifact, already checked by the caller. */
export function generatedImageVisual(bytes: Uint8Array, sha256: string): VisualEvidence {
  return {
    kind: "image",
    media: [{ id: `generated_image:${sha256}`, bytes, timestampMs: null, label: "Generated image", source: "storage_objects" }],
    coverage: { scope: "still_image", offered: 1, analysed: 1, durationMs: null, note: "A single still image was judged." },
  };
}

/** The sql LIKE pattern for the frames stored beside a video container. */
export function frameLike(storageKey: string): string {
  return `${storageKey.replace(/[\\%_]/g, (char) => `\\${char}`)}.frame.%`;
}

/**
 * The frames of a stored video that a judgment may use: up to four, chosen from frames sampled at real timestamps. Frames are
 * sampled only when the caller says so. The caller does that for OpenAI Decisions, and for JEV only when a perception provider
 * is ready to read them. A video with no container, no known duration, or no ffmpeg yields no frame, and the reason is kept.
 */
export async function videoVisualEvidence(
  sql: Sql,
  organizationId: string,
  brandId: string,
  storageKey: string,
  durationMs: number | null,
  options: { sample: boolean; extractor?: FrameExtractor },
): Promise<VisualEvidence> {
  const none = (unavailable: string, note: string): VisualEvidence => ({
    kind: "video_frames",
    media: [],
    coverage: { scope: "sampled_frames", offered: 0, analysed: 0, durationMs, note, unavailable },
  });
  if (!options.sample) return none("sampling_not_needed", "No frame was sampled: the judgment does not take frames from this video.");
  if (!storageKey || storageKey.startsWith("pending/")) return none("no_stored_container", "The video has no stored container, so no frame was sampled.");
  const rows = await sql<{ body: string }>`
    select body from asset_blobs
    where organization_id = ${organizationId} and brand_id = ${brandId} and storage_key = ${storageKey}
    limit 1
  `;
  const container = rows[0]?.body;
  if (!container) return none("no_stored_container", "The video has no stored container, so no frame was sampled.");

  const sample = await sampleVideoFrames({
    bytes: new Uint8Array(Buffer.from(container, "base64")),
    durationMs,
    extractor: options.extractor,
  });
  if (sample.unavailable) return none(sample.unavailable, `No frame could be sampled: ${sample.unavailable}.`);
  const selection = selectRepresentativeFrames(
    sample.frames.map((frame) => ({
      id: `${storageKey}@${frame.timestampMs}ms`,
      bytes: frame.bytes,
      timestampMs: frame.timestampMs,
      durationMs,
    })),
  );
  const offered = sample.frames.length;
  const analysed = selection.frames.length;
  const note = analysed < offered
    ? `Analysed ${analysed} of ${offered} sampled frames of a ${durationMs ?? "unknown"} ms video. The video was not inspected in full.`
    : `Analysed ${analysed} sampled frames of a ${durationMs ?? "unknown"} ms video. The video was not inspected in full.`;
  return {
    kind: "video_frames",
    media: selection.frames.map((frame) => ({
      id: frame.id,
      bytes: frame.bytes,
      timestampMs: frame.timestampMs,
      label: `Frame at ${frame.timestampMs}ms (${frame.role})`,
      source: "ffmpeg_sample",
    })),
    coverage: { scope: "sampled_frames", offered, analysed, durationMs, note },
  };
}
