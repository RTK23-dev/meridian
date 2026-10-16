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
  decisionSchema,
  edlSchema,
  envelopeSchema,
  gateResultSchema,
  intakeRejectionSchema,
  ledgerEntrySchema,
  manifestRoleCallSchema,
  manifestSchema,
  modelCatalogEntrySchema,
  modelChoiceSchema,
  personaSchema,
  productKitSchema,
  productionRequestSchema,
  providerErrorSchema,
  renderedVideoSchema,
  reviewResultSchema,
  scenePlanSchema,
  shotSpecSchema,
  chainProblem,
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
  scenePlanChainFixture,
  cartoonChainShotFixture,
  stopMotionChainShotFixture,
  videoDnaFixture,
  voiceTrackFixture,
  VOICE_DURATION_MS,
  validatedRequestFixture,
  edlFixture,
  takesFixture,
  manifestFixture,
  manifestRoleCallsFixture,
  ledgerClaudeFixture,
  ledgerFrameReaderFixture,
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
  scenePlanChain: scenePlanSchema,
  assetSpec: assetSpecSchema,
  assetSpecV6: assetSpecSchema,
  modelChoice: modelChoiceSchema,
  modelCatalogEntry: modelCatalogEntrySchema,
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
  ledgerEntryClaude: ledgerEntrySchema,
  ledgerEntryFrameReader: ledgerEntrySchema,
  decision: decisionSchema,
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

test("every role call fixture parses with the role-call schema on its own", () => {
  assert.equal(manifestRoleCallsFixture.length, 3);
  for (const call of manifestRoleCallsFixture) {
    const parsed = manifestRoleCallSchema.safeParse(call);
    assert.ok(parsed.success, `role call ${call.role} is invalid: ${parsed.success ? "" : parsed.error.message}`);
  }
});

test("the manifest's planner role call is the ledger's planner call: same model, prompt version and actual", () => {
  const planner = manifestRoleCallsFixture.find((call) => call.role === "planner");
  assert.ok(planner, "the manifest carries the planner call");
  assert.equal(planner.model, ledgerClaudeFixture.model);
  assert.equal(planner.promptVersion, ledgerClaudeFixture.promptVersion);
  assert.equal(planner.costUsd, ledgerClaudeFixture.actualUsd);
  assert.equal(manifestFixture.promptVersions.planner, ledgerClaudeFixture.promptVersion);
});

test("the editor's decision is about an EDL clip: its subject id is a clip of the EDL, and it is in the manifest (contract v4)", () => {
  const clipIds = new Set(edlFixture.tracks.flatMap((track) => track.clips.map((clip) => clip.clipId)));
  const editorDecisions = manifestFixture.decisions.filter((decision) => decision.by === "editor");
  assert.equal(editorDecisions.length, 1, "the manifest fixture logs one editor decision");
  for (const decision of editorDecisions) {
    assert.ok(clipIds.has(decision.at), `editor decision subject ${decision.at} is not a clip of the EDL`);
    assert.equal(decisionSchema.parse(decision).by, "editor");
  }
});

test("the frame_reader role is a Haiku check role: its ledger row and its role call parse, and its prompt version is its own", () => {
  assert.equal(ledgerFrameReaderFixture.role, "frame_reader");
  assert.equal(ledgerFrameReaderFixture.model, "anthropic/claude-haiku-5.5");
  assert.equal(ledgerFrameReaderFixture.promptVersion, "frame_reader@1");
  assert.equal(ledgerEntrySchema.safeParse(ledgerFrameReaderFixture).success, true);
  const call = { ...manifestRoleCallsFixture[1], role: "frame_reader", promptVersion: "frame_reader@1" };
  assert.equal(manifestRoleCallSchema.safeParse(call).success, true);
});

test("contract v5 is additive: every single-call shot of the fixture plan parses unchanged, and the plan round-trips", () => {
  assert.deepEqual(scenePlanSchema.parse(scenePlanFixture), scenePlanFixture);
  for (const shot of scenePlanFixture.shots) {
    assert.notEqual(shot.source.kind, "chain");
    assert.deepEqual(shotSpecSchema.parse(shot), shot, `${shot.shotId} changed when it parsed`);
  }
});

test("a chain shot parses, keeps its calls in order and round-trips unchanged (contract v5)", () => {
  assert.deepEqual(shotSpecSchema.parse(cartoonChainShotFixture), cartoonChainShotFixture);
  assert.deepEqual(shotSpecSchema.parse(stopMotionChainShotFixture), stopMotionChainShotFixture);
  assert.deepEqual(scenePlanSchema.parse(scenePlanChainFixture), scenePlanChainFixture);

  const cartoon = cartoonChainShotFixture.source;
  assert.equal(cartoon.kind, "chain");
  if (cartoon.kind !== "chain") return;
  assert.deepEqual(
    cartoon.calls.map((call) => call.output),
    ["keyframe", "clip"],
  );
  assert.deepEqual(
    cartoon.calls.map((call) => call.modelClass),
    ["image.keyframe", "video.budget"],
  );
  assert.deepEqual(cartoon.calls[1].firstFrame, { kind: "output", output: "keyframe" });

  const stop = stopMotionChainShotFixture.source;
  const frames = stop.kind === "chain" ? stop.calls : [];
  assert.equal(frames.length, 30);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(
      frames[i].refs.some((ref) => ref.kind === "output" && ref.output === frames[i - 1].output),
      `${frames[i].output} reads the frame before it`,
    );
  }
});

test("a chain link that refers to an unknown output is refused, and the refusal names the output (contract v5)", () => {
  const broken = structuredClone(cartoonChainShotFixture);
  if (broken.source.kind !== "chain") throw new Error("the fixture is a chain");
  broken.source.calls[1].firstFrame = { kind: "output", output: "keyframe_missing" };
  const result = shotSpecSchema.safeParse(broken);
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.issues.some((issue) => issue.message.includes('"keyframe_missing"')));
  assert.equal(chainProblem(broken.source.calls)?.index, 1);
});
