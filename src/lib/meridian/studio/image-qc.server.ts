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
import { CREATIVE_EVIDENCE_SCOPES, CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { judgeMedia, rollupDecision, ENGINE_REPLACED_MEDIA_QUESTIONS, type MediaFacts } from "./features.ts";
import type { AccountSnapshot } from "../publishing/readiness.ts";
import { measureLogo, measurePalette, combineLogoFrames, combinePaletteFrames, type LogoMeasurement, type PaletteMeasurement } from "../vision/measure.ts";
import { IMAGE_SCOPE, runEngineGate, type GateEvidenceInput, type GateEvidenceSelection, type GateImage, type GateQuestion } from "../decisions/gate.ts";
import { selectPerceptionProvider, type PerceptionInputMedia, type PerceptionRunOutcome } from "../perception/run.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionMediaKind } from "../perception/types.ts";
import { readVisualMedia } from "../providers/vision.server.ts";
import { EVIDENCE_CONTRACTS, PERCEPTION_EVIDENCE_NAME, checkQuestionContract, satisfiedContractLines } from "../perception/contracts.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { FRAME_SELECTION_VERSION, selectRepresentativeFrames, sha256Hex, type FrameSelection } from "../decisions/frames.ts";
import { sampleVideoFrames, type FrameExtractor } from "../video/sample-frames.ts";
import { resolveActiveEngine, type EngineSelection } from "../decisions/selection.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";
import type { DecisionUsage } from "../decisions/types.ts";
import { judgmentDecisionId, type RecordedDecision } from "./judgment-decision.ts";

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
  /** For sampled frames: the selection that chose them, recorded with the evidence and never sent as content. */
  selection?: GateEvidenceSelection;
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
  /** The engine gate's reason, in words a reviewer can read. */
  reason: string;
  /** The decision the creative points to: a local decision, or the gate record when the engine decided the outcome. */
  decisionId: string;
  gateRecordId: string | null;
  gateAction: PolicyOutcome;
  gateEngineCalled: boolean;
  /** The engine gate's spend: the engine, the models asked and reported, and the tokens the engine reported. Null usage when none. */
  gateEngineId: string | null;
  gateRequestedModel: string | null;
  gateReturnedModel: string | null;
  gateUsage: DecisionUsage | null;
  /** The perception run, when one was made. Absent when the engine received the media itself. */
  perceptionRunId: string | null;
};

const SEVERITY: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

/** The evidence name of how much of the creative was analysed. Every visual question's scope holds it. */
const VISUAL_COVERAGE_NAME = "visual_coverage";

/**
 * The content of the perception evidence item for one run: the contract lines of the contracts its observations satisfy in full.
 * A contract the observations do not satisfy contributes nothing, so no unknown fact is written out for any question.
 */
function perceptionContentFor(run: PerceptionRunOutcome): { satisfiedContracts: string[]; contracts: Record<string, string[]> } {
  const provenance = `${run.providerId} ${run.model} (prompt ${run.promptVersion})`;
  const label = (observation: MediaObservation) => {
    const media = run.media.find((item) => item.id === observation.mediaId);
    const when = observation.timestampMs !== null ? `at ${observation.timestampMs}ms` : "(still image)";
    return `${media?.label ?? observation.mediaId} ${when}, sha256 ${observation.sha256.slice(0, 12)}…`;
  };
  const { satisfied, lines } = satisfiedContractLines(run.observations, label, provenance);
  return { satisfiedContracts: satisfied, contracts: lines };
}

/**
 * The semantic questions for a creative, each with its evidence scope. OpenAI Decisions receives the visual questions with
 * their images, scoped to the image. JEV receives a visual question as text only when the perception observations satisfy that
 * question's own contract in full, and then only the question's scope holds them. Otherwise the question is refused with the
 * specific reason and goes to review. The text questions never receive an image or an observation.
 */
export function creativeGateQuestionsFor(input: { engineSeesImages: boolean; perception?: PerceptionRunOutcome; hasMedia: boolean }): GateQuestion[] {
  const text = ["creative.brand_fit.v1", "creative.opportunity_fit.v1", "creative.claim_compliance.v1"].map((id): GateQuestion => ({
    key: id,
    spec: CREATIVE_QUESTIONS[id]!,
    needsImage: false,
    evidenceScope: CREATIVE_EVIDENCE_SCOPES[id],
  }));
  const visual = ["creative.visual_quality.v1", "creative.product_visible.v1"].map((id): GateQuestion => {
    const spec = CREATIVE_QUESTIONS[id]!;
    const declared = CREATIVE_EVIDENCE_SCOPES[id] ?? [];
    if (input.engineSeesImages) return { key: id, spec, needsImage: true, evidenceScope: declared };
    // JEV cannot see images. The image scope becomes the perception observations, and nothing else is added.
    const scope = declared.map((name) => (name === IMAGE_SCOPE ? PERCEPTION_EVIDENCE_NAME : name));
    const contractId = spec.perceptionEvidence?.contract;
    if (!contractId || !EVIDENCE_CONTRACTS[contractId]) {
      return { key: id, spec, needsImage: true, localRefusal: { status: "unsupported", reason: "JEV has no perception evidence contract for this question, so it cannot judge it from text. Routed to human review." } };
    }
    // The requirement names the evidence that is actually supplied: the perception observations, not the image bytes.
    const judgedFromText = { ...spec, evidenceRequirements: spec.evidenceRequirements.map((item) => (item === "image" ? PERCEPTION_EVIDENCE_NAME : item)) };
    const perception = input.perception;
    if (!input.hasMedia) {
      return { key: id, spec, needsImage: true, localRefusal: { status: "abstain_insufficient_evidence", reason: "No image or frame was available to perceive. Routed to human review." } };
    }
    if (!perception || perception.status !== "observed") {
      const why = perception ? `${perception.failureKind ?? "failed"}: ${perception.message ?? "no detail"}` : "perception was not run";
      return { key: id, spec, needsImage: true, localRefusal: { status: "abstain_insufficient_evidence", reason: `Perception produced no evidence (${why}). Routed to human review.` } };
    }
    // This question's own contract, checked on its own. Another contract's result never satisfies it.
    const check = checkQuestionContract(contractId, perception.observations);
    if (!check.satisfied) {
      const unknown = check.missing.slice(0, 5).map((item) => `${item.field} (${item.mediaId})`).join(", ");
      return {
        key: id,
        spec: judgedFromText,
        needsImage: true,
        localRefusal: { status: "abstain_insufficient_evidence", reason: `${check.reason}${unknown ? ` Unknown: ${unknown}.` : ""} Routed to human review.` },
      };
    }
    return { key: id, spec: judgedFromText, needsImage: false, evidenceScope: scope };
  });
  return [...text, ...visual];
}

/**
 * The creative's own text, each item with the content a text question may receive. Competitor text and the generation prompt
 * are never placed here. A blank item is not evidence, so a question that needs it abstains.
 */
function creativeTextEvidence(facts: MediaFacts): GateEvidenceInput[] {
  const items: GateEvidenceInput[] = [];
  if (facts.copy.trim()) items.push({ kind: "text", name: "creative_copy", source: "creative_records", content: { kind: facts.kind, copy: facts.copy } });
  if (facts.transcript.trim()) items.push({ kind: "text", name: "transcript", source: "assets", content: { transcript: facts.transcript } });
  if (facts.positioning.trim()) {
    items.push({ kind: "text", name: "brand_positioning", source: "brand_brain", content: { positioning: facts.positioning, tone: facts.tone } });
  }
  if (facts.prohibited.trim()) {
    const prohibitedClaims = facts.prohibited.trim();
    items.push({ kind: "text", name: "brand_prohibited_claims", source: "brand_brain", content: { prohibitedClaims } });
    items.push({ kind: "text", name: "brand_claim_facts", source: "brand_brain", content: { prohibitedClaims } });
  }
  if (facts.angle.trim()) items.push({ kind: "text", name: "opportunity_angle", source: "opportunity", content: { angle: facts.angle } });
  if (facts.productName.trim()) items.push({ kind: "text", name: "product_name", source: "products", content: { productName: facts.productName } });
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
  let images: GateImage[] = [];
  let visualEvidence: GateEvidenceInput[] = [];
  let perceptionEvidence: GateEvidenceInput[] = [];
  let perceptionRunId: string | null = null;
  let perceptionOutcome: PerceptionRunOutcome | undefined;
  if (selection.engineId === "openai-decisions") {
    // Each image is tied to its evidence item by name, so it reaches only the questions whose scope holds that item.
    images = visual.media.map((item) => ({
      bytes: item.bytes,
      label: item.label,
      evidenceRef: { field: "scene", location: { startMs: item.timestampMs ?? undefined, frameId: item.id } },
      evidenceName: item.id,
    }));
    visualEvidence = visual.media.map((item) => ({
      kind: "image" as const,
      name: item.id,
      sha256: sha256Hex(item.bytes),
      timestampMs: item.timestampMs ?? undefined,
      source: item.source,
    }));
  } else if (visual.media.length > 0) {
    const provider = input.perception === undefined ? selectPerceptionProvider().provider : input.perception;
    // The media is checked by its own bytes and then perceived by the configured provider, through the shared runner.
    const run = await readVisualMedia(sql, {
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
    perceptionRunId = run.runId || null;
    perceptionOutcome = run;
    if (run.status === "observed") {
      perceptionEvidence = [
        {
          kind: "text",
          name: PERCEPTION_EVIDENCE_NAME,
          source: `perception_run:${run.runId}`,
          content: { ...perceptionContentFor(run), inferredBy: `${run.providerId} ${run.model}` },
        },
        ...run.media.map((item): GateEvidenceInput => ({
          kind: "image",
          name: item.id,
          sha256: item.sha256,
          timestampMs: item.timestampMs ?? undefined,
          source: `perception_run:${run.runId}`,
        })),
      ];
    }
  }

  const gate = await runEngineGate({
    sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "creative_qa",
    subject: { type: "creative", id: input.creativeId },
    description: `${input.facts.kind === "video" ? "Video" : "Image"} creative. Judge only the evidence provided.`,
    questions: creativeGateQuestionsFor({ engineSeesImages: selection.engineId === "openai-decisions", perception: perceptionOutcome, hasMedia: visual.media.length > 0 }),
    // How much of the creative was analysed is evidence for the visual questions only, under either engine.
    evidence: [
      ...creativeTextEvidence(input.facts),
      { kind: "text", name: VISUAL_COVERAGE_NAME, source: "visual_evidence", content: visual.coverage, selection: visual.selection },
      ...visualEvidence,
      ...perceptionEvidence,
    ],
    images,
    deterministicRejections,
    selection,
    engines: input.engines,
  });

  const gateIsMoreSevere = SEVERITY[gate.action] > SEVERITY[localRollup];
  const rollup: PolicyOutcome = gateIsMoreSevere ? gate.action : localRollup;
  const recorded: RecordedDecision[] = [];
  for (const decision of local) {
    // Deterministic per creative and question, so a retried judgment cannot record the same decision twice.
    const id = `${input.creativeId}:${decision.questionId}`;
    recorded.push({ id, decision: decision.decision });
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
    reason: gate.reason,
    // reviews.decision_id and rejections.decision_id reference jev_decisions, so decisionId names one of the rows written above.
    // The engine gate record is returned as gateRecordId and is never used as a decision id.
    decisionId: judgmentDecisionId(rollup, recorded),
    gateRecordId: gate.gateRecordId,
    gateAction: gate.action,
    gateEngineCalled: gate.engineCalled,
    gateEngineId: gate.engineId,
    gateRequestedModel: gate.requestedModel,
    gateReturnedModel: gate.returnedModel,
    gateUsage: gate.usage ?? null,
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

/** Why a video has no frame a judgment can use. The reason is recorded. It is never replaced by a guess. */
export type VideoFrameUnavailable = "no_stored_container" | "no_duration" | "ffmpeg_unavailable" | "container_too_large" | "no_eligible_frame";

const UNAVAILABLE_TEXT: Record<VideoFrameUnavailable, string> = {
  no_stored_container: "the video has no stored container",
  no_duration: "the video's duration is unknown, so no frame has a real time",
  ffmpeg_unavailable: "ffmpeg is not installed, so no frame could be decoded at a real time",
  container_too_large: "the stored container is too large to sample",
  no_eligible_frame: "no sampled frame could be decoded at its real timestamp",
};

/**
 * The representative frames of one stored video, as every production judgment of its visuals takes them. The sample is taken
 * once per video, from the stored container, at real timestamps (video/sample-frames.ts), and the selection is made once
 * (decisions/frames.ts). The logo and palette measurements and the visual questions both read this sample, so they judge the
 * same frames. The embedded stills stored beside a container have no timestamp, so they are never a judged frame.
 */
export type VideoFrameSample = {
  storageKey: string;
  durationMs: number | null;
  /** Frames decoded at their real timestamps. Zero when sampling could not run, or when no frame decoded. */
  offered: number;
  /** The representative selection over the decoded frames. Null only when sampling could not run at all. */
  selection: FrameSelection | null;
  /** Set when no frame can be judged, with the reason. Null when at least one selected frame can be judged. */
  unavailable: VideoFrameUnavailable | null;
};

export async function sampleVideoForJudgment(
  sql: Sql,
  organizationId: string,
  brandId: string,
  storageKey: string,
  durationMs: number | null,
  options: { extractor?: FrameExtractor } = {},
): Promise<VideoFrameSample> {
  const unavailable = (reason: VideoFrameUnavailable): VideoFrameSample => ({ storageKey, durationMs, offered: 0, selection: null, unavailable: reason });
  if (!storageKey || storageKey.startsWith("pending/")) return unavailable("no_stored_container");
  const rows = await sql<{ body: string }>`
    select body from asset_blobs
    where organization_id = ${organizationId} and brand_id = ${brandId} and storage_key = ${storageKey}
    limit 1
  `;
  const container = rows[0]?.body;
  if (!container) return unavailable("no_stored_container");

  const sample = await sampleVideoFrames({
    bytes: new Uint8Array(Buffer.from(container, "base64")),
    durationMs,
    extractor: options.extractor,
  });
  if (sample.unavailable) return unavailable(sample.unavailable);
  const selection = selectRepresentativeFrames(
    sample.frames.map((frame) => ({
      id: `${storageKey}@${frame.timestampMs}ms`,
      bytes: frame.bytes,
      timestampMs: frame.timestampMs,
      durationMs,
    })),
  );
  return {
    storageKey,
    durationMs,
    offered: sample.frames.length,
    selection,
    unavailable: selection.frames.length === 0 ? "no_eligible_frame" : null,
  };
}

function selectionRecordOf(selection: FrameSelection | null): GateEvidenceSelection | undefined {
  if (!selection) return undefined;
  return {
    version: selection.version,
    frames: selection.frames.map((frame) => ({ id: frame.id, role: frame.role, timestampMs: frame.timestampMs })),
    omitted: selection.omitted.length,
  };
}

/**
 * The logo and palette measurements of a video, made on the same representative frames the visual questions see. When no frame
 * is eligible, both are ABSENT with the reason: the check could not judge, and a missing measurement is never a match. The
 * evidence names the selection version and each measured frame with its real timestamp, so the local decision record shows them.
 */
export async function measureVideoFrames(
  sql: Sql,
  organizationId: string,
  brandId: string,
  sample: VideoFrameSample,
): Promise<{ measuredLogo: LogoMeasurement; measuredPalette: PaletteMeasurement }> {
  const frames = sample.selection?.frames ?? [];
  if (frames.length === 0) {
    const why = sample.unavailable ? UNAVAILABLE_TEXT[sample.unavailable] : UNAVAILABLE_TEXT.no_eligible_frame;
    const evidence = `Not measured: ${why} (${FRAME_SELECTION_VERSION}). Vision was not run and nothing was treated as a match.`;
    return {
      measuredLogo: { similarity: null, confidence: null, outcome: "ABSENT", evidence },
      measuredPalette: { distance: null, confidence: null, outcome: "ABSENT", extracted: [], evidence },
    };
  }
  const logos: LogoMeasurement[] = [];
  const palettes: PaletteMeasurement[] = [];
  for (const frame of frames) {
    const visual = await visualFacts(sql, organizationId, brandId, frame.bytes);
    logos.push(visual.measuredLogo);
    palettes.push(visual.measuredPalette);
  }
  const measured = `Frames measured (${FRAME_SELECTION_VERSION}): ${frames.map((frame) => `${frame.role} ${frame.id} at ${frame.timestampMs}ms`).join("; ")}.`;
  const logo = combineLogoFrames(logos);
  const palette = combinePaletteFrames(palettes);
  return {
    measuredLogo: { ...logo, evidence: `${logo.evidence} ${measured}` },
    measuredPalette: { ...palette, evidence: `${palette.evidence} ${measured}` },
  };
}

/**
 * The frames of a stored video that a visual judgment may use: the selected representative frames, of which there are up to four.
 * Frames are offered only when the caller says so. The caller does that for OpenAI Decisions, and for JEV only when a perception
 * provider is ready to read them. Pass `sampled` to reuse the sample the measurements were made on. A video with no frame that
 * can be judged yields no media, and the reason is kept in the coverage and the selection record.
 */
export async function videoVisualEvidence(
  sql: Sql,
  organizationId: string,
  brandId: string,
  storageKey: string,
  durationMs: number | null,
  options: { sample: boolean; extractor?: FrameExtractor; sampled?: VideoFrameSample },
): Promise<VisualEvidence> {
  const none = (unavailable: string, note: string, selection?: GateEvidenceSelection): VisualEvidence => ({
    kind: "video_frames",
    media: [],
    coverage: { scope: "sampled_frames", offered: 0, analysed: 0, durationMs, note, unavailable },
    selection,
  });
  if (!options.sample) return none("sampling_not_needed", "No frame was sampled: the judgment does not take frames from this video.");
  const sample = options.sampled ?? (await sampleVideoForJudgment(sql, organizationId, brandId, storageKey, durationMs, { extractor: options.extractor }));
  const selection = sample.selection;
  if (!selection || selection.frames.length === 0) {
    const reason = sample.unavailable ?? "no_eligible_frame";
    return none(reason, `No frame could be judged: ${UNAVAILABLE_TEXT[reason]}.`, selectionRecordOf(selection));
  }
  const offered = sample.offered;
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
    selection: selectionRecordOf(selection),
  };
}
