import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  assetSpecSchema,
  budgetReservationSchema,
  canonicalJson,
  characterSheetSchema,
  compositionSchema,
  contentHash,
  edlSchema,
  envelopeSchema,
  gateResultSchema,
  intakeRejectionSchema,
  ledgerEntrySchema,
  manifestSchema,
  personaSchema,
  productKitSchema,
  productionRequestSchema,
  providerErrorSchema,
  renderedVideoSchema,
  reviewResultSchema,
  scenePlanSchema,
  styleKitSchema,
  takeSchema,
  takeVerdictSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceKitSchema,
  voiceTrackSchema,
} from "./index.ts";
import {
  FIXTURE_IDS as ID,
  fixtures,
  productionRequestFixture,
  scenePlanFixture,
  videoDnaFixture,
  voiceTrackFixture,
  VOICE_DURATION_MS,
  validatedRequestFixture,
  edlFixture,
  takesFixture,
  manifestFixture,
  renderedVideoFixture,
  compositionFixture,
  reviewResultFixture,
  budgetReservationFixture,
  assetSpecFixture,
  scenePlanEnvelopeFixture,
  PROMPT_SHOT3,
} from "./fixtures/index.ts";

const schemas = {
  productionRequest: productionRequestSchema,
  validatedRequest: validatedRequestSchema,
  intakeRejection: intakeRejectionSchema,
  videoDna: videoDnaSchema,
  voiceTrack: voiceTrackSchema,
  scenePlan: scenePlanSchema,
  assetSpec: assetSpecSchema,
  take: takeSchema,
  takeVerdict: takeVerdictSchema,
  edl: edlSchema,
  gateResult: gateResultSchema,
  reviewResult: reviewResultSchema,
  composition: compositionSchema,
  renderedVideo: renderedVideoSchema,
  manifest: manifestSchema,
  budgetReservation: budgetReservationSchema,
  ledgerEntry: ledgerEntrySchema,
  ledgerEntryEstimated: ledgerEntrySchema,
  providerError: providerErrorSchema,
  styleKit: styleKitSchema,
  persona: personaSchema,
  characterSheet: characterSheetSchema,
  productKit: productKitSchema,
  voiceKit: voiceKitSchema,
  artifactEnvelope: envelopeSchema(scenePlanSchema),
} as const;

type SchemaName = keyof typeof schemas;

test("every top-level fixture parses with its schema", () => {
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const result: z.ZodType = schemas[name];
    const parsed = result.safeParse(fixtures[name]);
    assert.ok(parsed.success, `${name} fixture is invalid: ${parsed.success ? "" : parsed.error.message}`);
  }
});

test("parse, canonicalJson and parse again is stable for every fixture", () => {
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema: z.ZodType = schemas[name];
    const first = schema.parse(fixtures[name]);
    const text = canonicalJson(first);
    const second = schema.parse(JSON.parse(text));
    assert.equal(canonicalJson(second), text, `${name} changed on the second round trip`);
    assert.deepEqual(second, first, `${name} changed value on the second round trip`);
  }
});

test("the request, DNA, voice, plan, takes, EDL, composition, render, review and manifest agree", () => {
  const requestId = productionRequestFixture.requestId;
  assert.equal(validatedRequestFixture.requestId, requestId);
  assert.equal(scenePlanFixture.requestId, requestId);
  assert.equal(voiceTrackFixture.requestId, requestId);
  assert.equal(edlFixture.requestId, requestId);
  assert.equal(manifestFixture.requestId, requestId);
  assert.equal(budgetReservationFixture.requestId, requestId);
  assert.equal(scenePlanEnvelopeFixture.requestId, requestId);

  assert.equal(scenePlanFixture.videoDnaId, videoDnaFixture.videoDnaId);
  assert.equal(manifestFixture.videoDnaId, videoDnaFixture.videoDnaId);
  assert.equal(scenePlanFixture.voiceTrackId, voiceTrackFixture.voiceTrackId);

  assert.equal(compositionFixture.edlId, edlFixture.edlId);
  assert.equal(renderedVideoFixture.edlId, edlFixture.edlId);
  assert.equal(renderedVideoFixture.videoId, reviewResultFixture.videoId);
  assert.equal(manifestFixture.videoId, renderedVideoFixture.videoId);
});

test("the shots tile the voice duration exactly, with no gap or overlap", () => {
  const ordered = [...scenePlanFixture.shots].sort((a, b) => a.startMs - b.startMs);
  assert.equal(ordered[0].startMs, 0);
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(ordered[i].startMs, ordered[i - 1].endMs, `gap or overlap before shot ${i + 1}`);
  }
  assert.equal(ordered[ordered.length - 1].endMs, voiceTrackFixture.durationMs);
  assert.equal(voiceTrackFixture.durationMs, VOICE_DURATION_MS);
});

test("voice words contain every script word in order and the beat spans cover the duration", () => {
  const scriptWords = productionRequestFixture.script.beats.flatMap((beat) =>
    beat.text.replace(/[.,]/g, "").split(/\s+/),
  );
  assert.deepEqual(
    voiceTrackFixture.words.map((word) => word.text),
    scriptWords,
  );

  const spans = [...voiceTrackFixture.beatSpans];
  assert.equal(spans[0].startMs, 0);
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].startMs, spans[i - 1].endMs);
  }
  assert.equal(spans[spans.length - 1].endMs, voiceTrackFixture.durationMs);

  const beatIds = productionRequestFixture.script.beats.map((beat) => beat.beatId);
  assert.deepEqual(
    spans.map((span) => span.beatId),
    beatIds,
  );
});

test("every shot belongs to a beat of the request, and the request's must visual request is honoured", () => {
  const beatIds = new Set(productionRequestFixture.script.beats.map((beat) => beat.beatId));
  for (const shot of scenePlanFixture.shots) {
    assert.ok(beatIds.has(shot.beatId), `${shot.shotId} names an unknown beat`);
  }
  for (const visual of productionRequestFixture.visualRequests.filter((v) => v.strength === "must")) {
    const shot = scenePlanFixture.shots.find((s) => s.beatId === visual.beatId);
    assert.ok(shot, `no shot for must request on ${visual.beatId}`);
    assert.equal(shot.mustSatisfy, visual.want);
  }
});

test("every generated shot names a downgrade type", () => {
  for (const shot of scenePlanFixture.shots) {
    if (shot.source.kind === "generate") {
      assert.ok(shot.downgradeTo, `${shot.shotId} is generated without downgradeTo`);
    }
  }
});

test("the EDL runs for the voice duration and every clip stays inside it", () => {
  assert.equal(edlFixture.durationMs, voiceTrackFixture.durationMs);
  for (const track of edlFixture.tracks) {
    for (const clip of track.clips) {
      assert.ok(clip.startMs >= 0 && clip.endMs <= edlFixture.durationMs, `${clip.clipId} is outside the EDL`);
    }
  }
  assert.ok(edlFixture.audio.voice.endMs <= edlFixture.durationMs);
});

test("takes belong to planned shots, and the manifest reads costs and shots from them", () => {
  const shotIds = new Set(scenePlanFixture.shots.map((shot) => shot.shotId));
  const takeIds = new Set(takesFixture.map((take) => take.takeId));
  for (const take of takesFixture) {
    assert.ok(shotIds.has(take.shotId), `${take.takeId} belongs to an unplanned shot`);
  }
  for (const shot of manifestFixture.shots) {
    assert.ok(takeIds.has(shot.takeId), `manifest names unknown take ${shot.takeId}`);
    const planned = scenePlanFixture.shots.find((s) => s.shotId === shot.shotId);
    assert.equal(planned?.visualType, shot.visualType);
  }
  const generationCost = takesFixture.reduce((sum, take) => sum + take.costUsd, 0);
  assert.equal(manifestFixture.cost.generation, Number(generationCost.toFixed(4)));
  assert.equal(manifestFixture.cost.render, renderedVideoFixture.costUsd);
});

test("the render is keyed by the composition hash and the review gate matches the manifest", () => {
  assert.equal(renderedVideoFixture.idempotencyKey, compositionFixture.contentHash);
  assert.equal(compositionFixture.compositionId, ID.composition);
  assert.deepEqual(
    manifestFixture.gates.find((gate) => gate.gate === "post_render"),
    reviewResultFixture.result,
  );
  assert.equal(reviewResultFixture.result.subjectId, renderedVideoFixture.videoId);
});

test("the reservation reserves what the plan estimate needs, plus the redo allowance on generated shots", () => {
  const lines = budgetReservationFixture.lines;
  const shotLines = lines.filter((line) => line.shotId !== undefined);
  assert.equal(shotLines.length, scenePlanFixture.shots.length);
  const shotTotal = shotLines.reduce((sum, line) => sum + line.estimateUsd, 0);
  assert.equal(Number(shotTotal.toFixed(4)), scenePlanFixture.estimatedUsd);
  assert.equal(Number((scenePlanFixture.estimatedUsd * 0.25).toFixed(4)), budgetReservationFixture.redoAllowanceUsd);
});

test("the validated request's kits are the ones the request names", () => {
  const { request, kits } = validatedRequestFixture;
  assert.equal(kits.styleKit.id, request.page.styleKitId);
  assert.equal(kits.persona?.id, request.page.personaId);
  assert.equal(kits.voiceId, request.page.voiceId);
  assert.equal(kits.productKit?.id, request.product?.productKitId);
  assert.deepEqual(
    kits.characters.map((kit) => kit.id),
    request.page.characterIds ?? [],
  );
  assert.ok(validatedRequestFixture.estimatedSpeechMs <= request.constraints.maxMs * 1.1);
});

test("the asset spec is the generated shot's spec, with the same prompt", () => {
  const shot = scenePlanFixture.shots.find((s) => s.shotId === assetSpecFixture.shotId);
  assert.ok(shot && shot.source.kind === "generate");
  assert.equal(shot.source.prompt, assetSpecFixture.prompt);
  assert.equal(assetSpecFixture.prompt, PROMPT_SHOT3);
});

test("the envelope's contentHash is the hash of its body", () => {
  assert.equal(scenePlanEnvelopeFixture.contentHash, contentHash(scenePlanEnvelopeFixture.body));
});
