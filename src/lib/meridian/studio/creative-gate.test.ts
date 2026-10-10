import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "../decisions/types.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { PNG, studioTenant } from "../testing/durable-image-fixtures.ts";
import { generatedImageVisual, videoVisualEvidence, writeJudgment, type VisualEvidence } from "./image-qc.server.ts";
import { sampleTimestamps } from "../video/sample-frames.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaFacts } from "./features.ts";

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
  if (spec.id === CREATIVE_QUESTIONS["creative.brand_fit.v1"]!.id) return answered(spec, 0.97);
  if (spec.id === CREATIVE_QUESTIONS["creative.opportunity_fit.v1"]!.id) return answered(spec, 0.97);
  if (spec.id === CREATIVE_QUESTIONS["creative.claim_compliance.v1"]!.id) return answered(spec, 0.99);
  return undefined;
};

async function judge(options: {
  tenant: { organizationId: string; brandId: string };
  creativeId: string;
  facts?: MediaFacts;
  visual?: VisualEvidence;
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
    engines: options.engines,
  });
}

test("the engine judges brand fit and opportunity fit; the lexical local checks are no longer written as authority", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-brand-engine");
  const jev = stubEngine("jev", { respond: textApproves });
  const openai = stubEngine("openai-decisions");
  const creativeId = `creative-${randomUUID()}`;
  await judge({ tenant, creativeId, engines: registryWith(jev, openai), selectedEngine: "jev" });

  const asked = Object.values(jev.requests[0]!.questions).map((spec) => spec.id).sort();
  assert.ok(asked.includes(CREATIVE_QUESTIONS["creative.brand_fit.v1"]!.id), "brand fit is asked of the engine");
  assert.ok(asked.includes(CREATIVE_QUESTIONS["creative.opportunity_fit.v1"]!.id), "opportunity fit is asked of the engine");
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
  assert.equal(jev.requests.length, 1);
  assert.equal(jev.requests[0]!.images?.length ?? 0, 0, "JEV is never handed the image");
  const [record] = await sql<{ unresolved: unknown; imagesOmitted?: number }>`
    select unresolved from decision_gate_records where id = ${judged.gateRecordId}
  `;
  assert.match(JSON.stringify(record?.unresolved), /creative\.visual_quality\.v1/);
  assert.match(JSON.stringify(record?.unresolved), /unsupported/);
});

test("under OpenAI, the image reaches the engine once with the text questions, and a visual defect rejects the creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-visual");
  const defective: Responder = (spec) => {
    if (spec.id === CREATIVE_QUESTIONS["creative.visual_quality.v1"]!.id) return answered(spec, 0.1);
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
  assert.equal(openai.requests.length, 1, "one call carries the text and the image questions");
  assert.equal(openai.requests[0]!.images?.length, 1);
  assert.equal(jev.requests.length, 0);
  assert.equal(judged.gateAction, "REJECT", "a clear visual defect is a rejection from the engine");
  assert.equal(judged.rollup, "REJECT");
});

test("under OpenAI with no image supplied, the visual checks abstain and the creative is not approved", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-openai-no-image");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { respond: textApproves });
  const creativeId = `creative-${randomUUID()}`;
  const judged = await judge({ tenant, creativeId, engines: registryWith(jev, openai), selectedEngine: "openai-decisions" });
  assert.equal(openai.requests.length, 1, "the text questions still go to the engine once");
  assert.equal(openai.requests[0]!.images?.length ?? 0, 0);
  assert.equal(judged.gateAction, "HUMAN_REVIEW");
  assert.notEqual(judged.rollup, "AUTO_APPROVE");
});

test("a provider failure on the engine is human review, never approval, and the other engine is not called", async () => {
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
  assert.equal(jev.requests.length, 0, "no silent switch to JEV");
});

test("a video is sampled only for an engine that can see images; under JEV nothing is sampled or sent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-video-jev");
  const storageKey = `video-${randomUUID()}.mp4`;
  let extracted = 0;
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, {
    selection: { engineId: "jev", source: "workspace" },
    extractor: async () => {
      extracted += 1;
      return PNG;
    },
  });
  assert.deepEqual(visual.images, []);
  assert.equal(visual.frames?.unavailable, "engine_cannot_see_images");
  assert.equal(extracted, 0, "no frame is extracted for an engine that cannot use it");
});

test("under OpenAI, a video with no stored container sends no frame and says why", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "creative-video-no-container");
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, `missing-${randomUUID()}.mp4`, 3000, {
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.deepEqual(visual.images, []);
  assert.equal(visual.frames?.unavailable, "no_stored_container");
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
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, {
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(visual.frames?.unavailable, undefined);
  assert.equal(visual.frames?.sampled, sampleTimestamps(3000).length, "every sample was taken from the clip");
  assert.ok(visual.images.length >= 1 && visual.images.length <= 4, "at most four frames are provided");
  assert.equal(visual.images.length, visual.evidence.length);
  for (const item of visual.evidence) {
    assert.equal(item.kind, "image");
    assert.equal(typeof item.timestampMs, "number", "each frame carries its real timestamp");
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
  assert.equal(openai.requests.length, 1);
  assert.equal(openai.requests[0]!.images?.length, visual.images.length, "the engine receives exactly the frames that were provided");
  assert.equal(judged.gateEngineCalled, true);
  const [record] = await sql<{ evidence: unknown }>`
    select evidence from decision_gate_records where id = ${judged.gateRecordId}
  `;
  assert.match(JSON.stringify(record?.evidence), /ffmpeg_sample/, "the record names where each frame came from");
});
