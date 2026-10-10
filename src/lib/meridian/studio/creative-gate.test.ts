import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// The runner resolves a credential for every run, exactly as production does. These tests use the deployment's shared default,
// which is the explicit setting that makes a Gemini key usable for perception without a saved workspace key.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-0123456789abcdef-test";
process.env.PERCEPTION_SHARED_DEFAULT = "gemini";
process.env.MERIDIAN_GEMINI_API_KEY = "test-shared-gemini-key";
import { getSql } from "../../db.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "../decisions/types.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { PNG, studioTenant } from "../testing/durable-image-fixtures.ts";
import { generatedImageVisual, videoVisualEvidence, writeJudgment, type VisualEvidence } from "./image-qc.server.ts";
import { sampleTimestamps } from "../video/sample-frames.ts";
import { solidFrame } from "../video/inspect.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionMedia, PerceptionResult } from "../perception/types.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeMedia, type MediaFacts } from "./features.ts";
import { QUESTION_SPECS } from "../jev/judgment.ts";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;

const facts: MediaFacts = {
  kind: "image",
  positioning: "Helps busy parents plan a calm dinner in ten minutes.",
  tone: "warm",
  prohibited: "guaranteed",
  wordsToAvoid: "",
  productName: "MealKit",
  angle: "dinner in ten minutes",
  copy: "MealKit: a calm dinner in ten minutes.",
  prompt: "Still of MealKit.",
  competitorTexts: [],
  ownTexts: [],
  mime: "image/png",
  byteSize: PNG.byteLength,
  width: 64,
  height: 64,
  checksum: "abc123def4567890",
  durationMs: null,
  transcript: "",
  sceneCount: 0,
  logoSimilarity: null,
  logoOutcome: "ABSENT",
  paletteDistance: null,
  paletteOutcome: "ABSENT",
  semanticSimilarity: null,
};

// Answers from a stub engine, keyed by the registry question id. Each stub records every request it receives.
type Responder = (spec: JevQuestionSpec) => JevAnswer | undefined;

/** A probability answer. `calibrated` models a calibrated value; engines report "uncalibrated" today. */
function answered(spec: JevQuestionSpec, probability: number, calibrated = false): JevAnswer {
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
    calibrationStatus: calibrated ? "calibrated" : "uncalibrated",
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
      imageMimeTypes: id === "openai-decisions" ? ["image/png"] : [],
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
        inputModality: request.images && request.images.length > 0 ? "text+image" : "text",
        imageCount: request.images?.length ?? 0,
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

const textApproves: Responder = (spec) => {
  if (spec.id === CREATIVE_QUESTIONS["creative.brand_fit.v1"]!.id) return answered(spec, 0.97, true);
  if (spec.id === CREATIVE_QUESTIONS["creative.opportunity_fit.v1"]!.id) return answered(spec, 0.97, true);
  if (spec.id === CREATIVE_QUESTIONS["creative.claim_compliance.v1"]!.id) return answered(spec, 0.99, true);
  return undefined;
};

async function judge(options: {
  tenant: { organizationId: string; brandId: string };
  creativeId: string;
  facts?: MediaFacts;
  visual?: VisualEvidence;
  perception?: MultimodalPerceptionProvider | null;
  engines: DecisionEngineRegistry;
  selectedEngine: DecisionEngineId;
}) {
  const sql = await getSql();
  // The workspace selection is set through the real save path, so the gate resolves the engine as production does.
  const { saveWorkspaceEngine } = await import("../decisions/selection.ts");
  await saveWorkspaceEngine(sql, {
    organizationId: options.tenant.organizationId,
    actorId: "test-user",
    engineId: options.selectedEngine,
    targetHealth: { status: "READY" },
  });
  return writeJudgment(sql, {
    organizationId: options.tenant.organizationId,
    brandId: options.tenant.brandId,
    creativeId: options.creativeId,
    facts: options.facts ?? facts,
    visual: options.visual,
    perception: options.perception ?? null,
    engines: options.engines,
  });
}

const BRAND_FIT = CREATIVE_QUESTIONS["creative.brand_fit.v1"]!.id;
const OPPORTUNITY_FIT = CREATIVE_QUESTIONS["creative.opportunity_fit.v1"]!.id;

test("the engine judges brand fit and opportunity fit; the lexical local checks are no longer written as authority", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-brand-engine");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions");
  const creativeId = `creative-${randomUUID()}`;
  await judge({ tenant, creativeId, engines: registryWith(jev, openai), selectedEngine: "jev" });

  const asked = jev.requests.flatMap((request) => Object.values(request.questions).map((spec) => spec.id));
  assert.ok(asked.includes(BRAND_FIT), "brand fit is asked of the engine");
  assert.ok(asked.includes(OPPORTUNITY_FIT), "opportunity fit is asked of the engine");
  // Brand fit is asked with the creative's text and the brand positioning, and nothing else. No image, no observation.
  const brandCall = jev.requests.find((request) => Object.values(request.questions).some((spec) => spec.id === BRAND_FIT))!;
  assert.deepEqual([...(brandCall.state.availableEvidence as string[])].sort(), ["brand_positioning", "creative_copy"]);
  assert.equal(brandCall.images?.length ?? 0, 0, "brand fit never receives an image");
  assert.doesNotMatch(JSON.stringify(brandCall.state), /perception_observations|productPresence|Frame at/, "brand fit never receives an observation");
  const rows = await sql<{ question_id: string }>`
    select question_id from jev_decisions where subject_id = ${creativeId}
  `;
  assert.ok(!rows.some((row) => row.question_id === "brand_fit"), "no local brand_fit decision is written");
  assert.ok(!rows.some((row) => row.question_id === "opportunity_quality"), "no local opportunity_quality decision is written");
  assert.ok(rows.some((row) => row.question_id === "claim_safety"), "the literal claim check stays local");
});

test("a local deterministic rejection is final: a prohibited phrase rejects the creative and no engine is asked", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-deterministic");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const guaranteed = { ...facts, copy: "MealKit: a guaranteed calm dinner in ten minutes." };
  const judged = await judge({ tenant, creativeId, facts: guaranteed, engines: registryWith(jev, openai), selectedEngine: "openai-decisions" });
  assert.equal(judged.rollup, "REJECT");
  assert.equal(judged.gateEngineCalled, false, "the engine is not asked to override a literal rejection");
  assert.equal(openai.requests.length + jev.requests.length, 0);
  const [record] = await sql<{ engine_called: boolean; action: string }>`
    select engine_called, action from decision_gate_records where id = ${judged.gateRecordId}
  `;
  assert.equal(record?.engine_called, false);
  assert.equal(record?.action, "REJECT");
});

test("a product missing from the creative's text is a final local rejection, calibrated or not, and no engine is asked", async () => {
  // The variant text is the copy, the generation prompt, and the transcript. None of them names the product here.
  const unnamed = { ...facts, copy: "A calm dinner in ten minutes, with nothing named.", prompt: "A calm dinner still.", transcript: "" };
  const productOf = (decisions: ReturnType<typeof judgeMedia>) => decisions.find((item) => item.questionId === "product_match");
  // The production creative check, judgeMedia, with no calibration: a violation rejects.
  assert.equal(productOf(judgeMedia(unnamed))?.decision, "REJECT");
  // The same check with a calibration step. A violation is evidence, not a score, so it still rejects.
  const spec = QUESTION_SPECS.find((item) => item.id === "product_match");
  assert.ok(spec, "the product question is registered");
  const policies = new Map([
    ["product_match", { thresholds: spec.thresholds, policyVersion: "product.test.v1", calibration: { version: "identity.product.v1", apply: (score: number) => score } }],
  ]);
  assert.equal(productOf(judgeMedia(unnamed, policies))?.decision, "REJECT");
  // The production path end to end: the creative is judged, the literal miss is final, and no engine is asked.
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-product-missing");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const judged = await judge({ tenant, creativeId: `creative-${randomUUID()}`, facts: unnamed, engines: registryWith(jev, openai), selectedEngine: "jev" });
  assert.equal(judged.rollup, "REJECT");
  assert.equal(judged.gateEngineCalled, false, "the engine is not asked to override a literal miss");
  assert.equal(jev.requests.length + openai.requests.length, 0, "no engine request is made");
});

test("under JEV, the visual checks are unsupported: the creative goes to review, OpenAI is never called, and JEV gets no image", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-jev-visual");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { respond: () => undefined });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({
    tenant,
    creativeId,
    visual: generatedImageVisual(PNG, "a".repeat(64)),
    engines: registryWith(jev, openai),
    selectedEngine: "jev",
  });
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
  assert.equal(openai.requests.length, 0, "no silent OpenAI call for visual judgment");
  assert.equal(jev.requests.length, 3, "the three text scopes are judged, one call each");
  assert.ok(jev.requests.every((request) => (request.images?.length ?? 0) === 0), "JEV is never handed the image");
  const asked = jev.requests.flatMap((request) => Object.keys(request.questions));
  assert.ok(!asked.includes(CREATIVE_QUESTIONS["creative.visual_quality.v1"]!.id), "no visual question is sent to JEV");
  const [record] = await sql<{ unresolved: unknown; imagesOmitted?: number }>`
    select unresolved from decision_gate_records where id = ${judged.gateRecordId}
  `;
  assert.match(JSON.stringify(record?.unresolved), /creative\.visual_quality\.v1/);
  assert.match(JSON.stringify(record?.unresolved), /abstain_insufficient_evidence/, "the missing perception evidence is stated as missing, not as a judgment");
});

test("under OpenAI, each scope is one call, the image reaches only the visual calls, and a calibrated visual defect rejects the creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-visual");
  const defective: Responder = (spec) => {
    if (spec.id === CREATIVE_QUESTIONS["creative.visual_quality.v1"]!.id) return answered(spec, 0.1, true);
    return textApproves(spec);
  };
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: defective });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({
    tenant,
    creativeId,
    visual: generatedImageVisual(PNG, "b".repeat(64)),
    engines: registryWith(jev, openai),
    selectedEngine: "openai-decisions",
  });
  // Three text scopes and two visual scopes: five calls, all to OpenAI. Only the two visual calls carry the image.
  assert.equal(openai.requests.length, 5, "one call per evidence scope");
  const imageCalls = openai.requests.filter((request) => (request.images?.length ?? 0) > 0);
  assert.equal(imageCalls.length, 2, "two visual calls carry the image");
  assert.ok(imageCalls.every((request) => request.images?.length === 1));
  assert.equal(jev.requests.length, 0);
  assert.equal(judged.gateAction, "REJECT", "a calibrated visual defect is a rejection from the engine");
  assert.equal(judged.rollup, "REJECT");
});

test("an uncalibrated visual defect cannot reject the creative: it goes to review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-uncalibrated-defect");
  const defective: Responder = (spec) => {
    if (spec.id === CREATIVE_QUESTIONS["creative.visual_quality.v1"]!.id) return answered(spec, 0.1);
    return textApproves(spec);
  };
  const judged = await judge({
    tenant,
    creativeId: `creative-${randomUUID()}`,
    visual: generatedImageVisual(PNG, "e".repeat(64)),
    engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { respond: defective })),
    selectedEngine: "openai-decisions",
  });
  assert.equal(judged.gateAction, "HUMAN_REVIEW", "an uncalibrated probability routes to review, it does not reject");
  assert.notEqual(judged.rollup, "REJECT");
});

test("under OpenAI with no image supplied, the visual checks abstain and the creative is not approved", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-no-image");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({ tenant, creativeId, engines: registryWith(jev, openai), selectedEngine: "openai-decisions" });
  assert.equal(openai.requests.length, 3, "the three text scopes still go to the engine, one call each");
  assert.ok(openai.requests.every((request) => (request.images?.length ?? 0) === 0));
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
});

test("a provider failure on the engine is human review, never approval; the later scopes are not sent and JEV is not called", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-provider-failure");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { failure: true });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({
    tenant,
    creativeId,
    visual: generatedImageVisual(PNG, "c".repeat(64)),
    engines: registryWith(jev, openai),
    selectedEngine: "openai-decisions",
  });
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
  assert.equal(openai.requests.length, 1, "the first scope fails, and the later scopes are not sent to the same engine");
  assert.equal(jev.requests.length, 0, "no silent switch to JEV");
});

/** A stub perception provider. It records each call, so a test can prove whether production asked for perception. */
function stubPerception(options: { fail?: boolean; complete?: boolean } = {}) {
  const calls: PerceptionMedia[][] = [];
  const provider: MultimodalPerceptionProvider = {
    id: "stub_perception",
    model: "stub-model-1",
    promptVersion: "stub-prompt.v1",
    health: async () => ({ id: "stub_perception", state: "HEALTHY", detail: "ready" }),
    perceive: async (input): Promise<PerceptionResult> => {
      calls.push(input.media);
      if (options.fail) {
        return { status: "failed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", failureKind: "timeout", message: "stub timeout", latencyMs: 1 };
      }
      const observations: MediaObservation[] = input.media.map((item) => (options.complete
        ? {
          mediaId: item.id, sha256: item.sha256, timestampMs: item.timestampMs, basis: "inferred",
          productPresence: true, productProminence: "prominent", productObstructed: false,
          sharpness: "sharp", lighting: "good", composition: "balanced", legibility: "no_text", artifactsVisible: false,
        }
        : {
          mediaId: item.id, sha256: item.sha256, timestampMs: item.timestampMs, basis: "inferred", productPresence: true, ocrText: "Calm dinner, ten minutes",
        }));
      return { status: "observed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", observations, latencyMs: 2 };
    },
  };
  return { provider, calls };
}

/** Two sampled frames of a video, with their real timestamps, as the sampler provides them. */
function sampledVideo(): VisualEvidence {
  return {
    kind: "video_frames",
    media: [
      { id: "frame-0", bytes: solidFrame(16, 16, [200, 20, 20]), timestampMs: 0, label: "Frame at 0ms (hook)", source: "ffmpeg_sample" },
      { id: "frame-1500", bytes: solidFrame(16, 16, [20, 200, 20]), timestampMs: 1500, label: "Frame at 1500ms (cta)", source: "ffmpeg_sample" },
    ],
    coverage: { scope: "sampled_frames", offered: 8, analysed: 2, durationMs: 3000, note: "Analysed 2 of 8 sampled frames of a 3000 ms video. The video was not inspected in full." },
  };
}

test("frames are sampled only for an engine that takes them, or when perception is ready to read them", async () => {
  let extracted = 0;
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-video-sampling-gate");
  const neither = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, `video-${randomUUID()}.mp4`, 3000, {
    sample: false,
    extractor: async () => {
      extracted += 1;
      return PNG;
    },
  });
  assert.deepEqual(neither.media, []);
  assert.equal(neither.coverage.unavailable, "sampling_not_needed");
  assert.equal(extracted, 0, "no frame is extracted when nothing will read it");
});

test("under JEV with perception ready: the visual question reads the grounded contract lines only, JEV is never handed an image, and text questions read no observation", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-jev-perception");
  const perception = stubPerception({ complete: true });
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({
    tenant, creativeId, facts: { ...facts, kind: "video", transcript: "", durationMs: 3000, sceneCount: 1 },
    visual: sampledVideo(), perception: perception.provider, engines: registryWith(jev, openai), selectedEngine: "jev",
  });
  assert.equal(perception.calls.length, 1, "perception analyses the frames once");
  assert.equal(perception.calls[0]?.length, 2);
  assert.equal(openai.requests.length, 0, "no silent OpenAI call for visual judgment");
  assert.ok(jev.requests.every((request) => (request.images?.length ?? 0) === 0), "JEV is never handed an image");
  const visualCall = jev.requests.find((request) => (request.state.availableEvidence as string[]).includes("perception_observations"));
  assert.ok(visualCall, "one call carries the perception observations");
  const visualState = JSON.stringify(visualCall.state);
  assert.match(visualState, /Frame at 0ms/, "JEV reads the grounded observation with its real timestamp");
  assert.match(visualState, /not inspected in full/, "JEV is told the video was only partly analysed");
  // A text question is a call whose scope does not hold the observations. Every visual call holds them.
  const textCalls = jev.requests.filter((request) => !(request.state.availableEvidence as string[]).includes("perception_observations"));
  assert.equal(textCalls.length, 3, "the three text scopes are the calls without observations");
  const textState = textCalls.map((request) => JSON.stringify(request.state)).join("\n");
  assert.doesNotMatch(textState, /Frame at|perception_observations|not inspected/, "the text questions never receive an observation or the coverage");
  assert.equal(judged.perceptionRunId !== null, true, "the perception run is recorded");
  assert.equal(judged.gateAction, "HUMAN_REVIEW", "the visual questions have no answer under this stub, so the creative is reviewed");
  const [record] = await sql<{ evidence: unknown }>`select evidence from decision_gate_records where id = ${judged.gateRecordId}`;
  assert.match(JSON.stringify(record?.evidence), /perception_observations/);
  assert.match(JSON.stringify(record?.evidence), new RegExp(`perception_run:${judged.perceptionRunId}`));
});

test("under JEV with perception unavailable: the creative is held for review, OpenAI is not called, and JEV still judges the text", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-jev-no-perception");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({ tenant, creativeId, visual: sampledVideo(), perception: null, engines: registryWith(jev, openai), selectedEngine: "jev" });
  assert.equal(openai.requests.length, 0, "no substitute engine");
  assert.equal(jev.requests.length, 3, "the three text scopes are still judged, one call each");
  assert.doesNotMatch(JSON.stringify(jev.requests.map((request) => request.state)), /perception|analysed|Frame at/, "no perception and no coverage reaches a text question");
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
  const [record] = await sql<{ unresolved: unknown }>`select unresolved from decision_gate_records where id = ${judged.gateRecordId}`;
  assert.match(JSON.stringify(record?.unresolved), /not_configured|No perception provider is ready/, "the unavailable perception is stated for the visual questions");
});

test("under JEV with a perception failure: the failure is recorded with its kind, and nothing is made up from it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-jev-perception-failed");
  const perception = stubPerception({ fail: true });
  const jev = stubEngine("jev", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({ tenant, creativeId, visual: sampledVideo(), perception: perception.provider, engines: registryWith(jev, stubEngine("openai-decisions")), selectedEngine: "jev" });
  assert.doesNotMatch(JSON.stringify(jev.requests.map((request) => request.state)), /Frame at 0ms \(|perception_observations/, "no observation is attached to a failed run");
  assert.equal(jev.requests.length, 3, "the text scopes are judged, one call each");
  const [record] = await sql<{ unresolved: unknown }>`select unresolved from decision_gate_records where id = ${judged.gateRecordId}`;
  assert.match(JSON.stringify(record?.unresolved), /timeout/, "the failure kind is stated for the visual questions");
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
});

test("under OpenAI Decisions the frames go to the engine directly, with their timestamps, and perception is never called", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-direct");
  const perception = stubPerception();
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const visual = sampledVideo();
  const judged = await judge({ tenant, creativeId, facts: { ...facts, kind: "video", transcript: "", durationMs: 3000, sceneCount: 1 }, visual, perception: perception.provider, engines: registryWith(jev, openai), selectedEngine: "openai-decisions" });
  assert.equal(perception.calls.length, 0, "perception is not a second analysis of the same frames");
  assert.equal(jev.requests.length, 0);
  // Three text scopes and two visual scopes. Only the visual calls carry the frames.
  assert.equal(openai.requests.length, 5, "one call per evidence scope");
  const frameCalls = openai.requests.filter((request) => (request.images?.length ?? 0) > 0);
  assert.equal(frameCalls.length, 2, "the two visual calls carry the frames");
  assert.ok(frameCalls.every((request) => request.images?.length === 2));
  assert.equal(judged.perceptionRunId, null);
  const [record] = await sql<{ evidence: unknown }>`select evidence from decision_gate_records where id = ${judged.gateRecordId}`;
  assert.match(JSON.stringify(record?.evidence), /"timestampMs":1500/, "the record names each frame with its real timestamp");
});

test("a video with no stored container sends no frame under OpenAI, and the reason is recorded", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-video-no-container");
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, `missing-${randomUUID()}.mp4`, 3000, { sample: true });
  assert.deepEqual(visual.media, []);
  assert.equal(visual.coverage.unavailable, "no_stored_container");
});

test("real ffmpeg, under OpenAI: up to four sampled frames reach the engine with their real timestamps, and the record names them", { skip: ffmpegAvailable ? false : "ffmpeg is not installed here" }, async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-video-frames");
  const storageKey = `video-${randomUUID()}.mp4`;
  const dir = mkdtempSync(join(tmpdir(), "meridian-creative-video-"));
  let clip: Buffer;
  try {
    const path = join(dir, "clip.mp4");
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
    assert.equal(made.status, 0, String(made.stderr));
    clip = readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, lifecycle)
    values (${storageKey}, ${tenant.organizationId}, ${tenant.brandId}, ${clip.toString("base64")}, 'video/mp4', 'sum', ${clip.byteLength}, 'stored')
  `;
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, { sample: true });
  assert.equal(visual.coverage.unavailable, undefined);
  assert.equal(visual.coverage.offered, sampleTimestamps(3000).length, "every sample was taken from the clip");
  assert.ok(visual.media.length >= 1 && visual.media.length <= 4, "at most four frames are provided");
  for (const item of visual.media) {
    assert.ok(sampleTimestamps(3000).includes(item.timestampMs!), "the timestamp is one that was actually sampled");
  }

  const creativeId = `creative-${randomUUID()}`;
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const judged = await judge({
    tenant,
    creativeId,
    facts: { ...facts, kind: "video", transcript: "", durationMs: 3000, sceneCount: 1 },
    visual,
    engines: registryWith(stubEngine("jev"), openai),
    selectedEngine: "openai-decisions",
  });
  assert.equal(openai.requests.length, 5, "three text scopes and two visual scopes");
  const frameCalls = openai.requests.filter((request) => (request.images?.length ?? 0) > 0);
  assert.equal(frameCalls.length, 2, "the two visual scopes each receive the frames");
  assert.ok(frameCalls.every((request) => request.images?.length === visual.media.length), "each visual call receives exactly the frames that were provided");
  assert.equal(judged.gateEngineCalled, true);
  const [record] = await sql<{ evidence: unknown }>`select evidence from decision_gate_records where id = ${judged.gateRecordId}`;
  assert.match(JSON.stringify(record?.evidence), /ffmpeg_sample/, "the record names where each frame came from");
});
