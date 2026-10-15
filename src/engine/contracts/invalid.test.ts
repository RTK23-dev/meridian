import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  assetSpecSchema,
  budgetReservationSchema,
  characterSheetSchema,
  compositionSchema,
  decisionSchema,
  edlSchema,
  envelopeSchema,
  gateResultSchema,
  intakeRejectionSchema,
  ledgerEntrySchema,
  manifestRoleCallSchema,
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
  fixtureId,
  assetSpecFixture,
  budgetReservationFixture,
  characterSheetFixture,
  compositionFixture,
  edlFixture,
  editorDecisionFixture,
  gateResultFixture,
  intakeRejectionFixture,
  ledgerClaudeFixture,
  ledgerFrameReaderFixture,
  ledgerRenderFixture,
  manifestRoleCallsFixture,
  manifestFixture,
  personaFixture,
  productKitFixture,
  productionRequestFixture,
  providerErrorFixture,
  renderedVideoFixture,
  reviewResultFixture,
  scenePlanEnvelopeFixture,
  scenePlanFixture,
  styleKitFixture,
  take1Fixture,
  takeVerdictFixture,
  validatedRequestFixture,
  videoDnaFixture,
  voiceKitFixture,
  voiceTrackFixture,
} from "./fixtures/index.ts";

type Case = { name: string; schema: z.ZodType; value: unknown };

/** A deep copy of a fixture with one edit applied. The edit may throw if the path is missing. */
function edit<T>(base: T, change: (draft: any) => void): unknown {
  const draft = structuredClone(base);
  change(draft);
  return draft;
}

function without<T extends object>(base: T, key: keyof T): unknown {
  const copy: Partial<T> = { ...base };
  delete copy[key];
  return copy;
}

const cases: Case[] = [
  // ProductionRequest: literal, id prefix, negative time, literal aspect, missing field, empty list, bad enum.
  { name: "request: wrong schema literal", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.schema = "meridian.production_request/v2")) },
  { name: "request: requestId with the dna prefix", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.requestId = ID.dna)) },
  { name: "request: negative maxMs", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.constraints.maxMs = -1)) },
  { name: "request: aspect 16:9", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.constraints.aspect = "16:9")) },
  { name: "request: missing workspaceId", schema: productionRequestSchema, value: without(productionRequestFixture, "workspaceId") },
  { name: "request: no script beats", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.script.beats = [])) },
  { name: "request: unknown gene id", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.format.keep = ["vibes"])) },
  { name: "request: master false", schema: productionRequestSchema, value: edit(productionRequestFixture, (d) => (d.output.master = false)) },
  { name: "validated request: requestId differs from request", schema: validatedRequestSchema, value: edit(validatedRequestFixture, (d) => (d.requestId = fixtureId("req_", 99))) },
  { name: "validated request: no styleKit reference", schema: validatedRequestSchema, value: edit(validatedRequestFixture, (d) => delete d.kits.styleKit) },
  { name: "intake rejection: no reasons", schema: intakeRejectionSchema, value: edit(intakeRejectionFixture, (d) => (d.reasons = [])) },

  // VideoDNA: id prefix, reversed span, unknown gene key, curve length.
  { name: "dna: videoDnaId with the request prefix", schema: videoDnaSchema, value: edit(videoDnaFixture, (d) => (d.videoDnaId = ID.request)) },
  { name: "dna: segment ends before it starts", schema: videoDnaSchema, value: edit(videoDnaFixture, (d) => ((d.segments[0].startMs = 4000))) },
  { name: "dna: unknown gene key in genome", schema: videoDnaSchema, value: edit(videoDnaFixture, (d) => (d.genome.vibes = "warm")) },
  { name: "dna: shot-length curve has 9 values", schema: videoDnaSchema, value: edit(videoDnaFixture, (d) => d.editGrammar.shotLengthMs.curve.pop()) },

  // VoiceTrack: positive duration, negative time, empty word.
  { name: "voice: zero duration", schema: voiceTrackSchema, value: edit(voiceTrackFixture, (d) => (d.durationMs = 0)) },
  { name: "voice: negative beat start", schema: voiceTrackSchema, value: edit(voiceTrackFixture, (d) => (d.beatSpans[0].startMs = -10)) },
  { name: "voice: empty word text", schema: voiceTrackSchema, value: edit(voiceTrackFixture, (d) => (d.words[0].text = "")) },

  // ScenePlan: discriminated source, span, visual type, money.
  { name: "plan: unknown source kind", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.shots[0].source.kind = "video")) },
  { name: "plan: shot ends at its start", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.shots[0].endMs = d.shots[0].startMs)) },
  { name: "plan: unknown visual type", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.shots[1].visualType = "hologram")) },
  { name: "plan: negative estimate", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.estimatedUsd = -0.01)) },
  { name: "plan: estimate with five decimals", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.estimatedUsd = 0.35161)) },
  { name: "plan: shot id with the take prefix", schema: scenePlanSchema, value: edit(scenePlanFixture, (d) => (d.shots[0].shotId = ID.take1)) },

  // AssetSpec: literal aspect, width, takes union, seed range.
  { name: "asset spec: aspect 16:9", schema: assetSpecSchema, value: edit(assetSpecFixture, (d) => (d.aspect = "16:9")) },
  { name: "asset spec: width 1280", schema: assetSpecSchema, value: edit(assetSpecFixture, (d) => (d.width = 1280)) },
  { name: "asset spec: three takes", schema: assetSpecSchema, value: edit(assetSpecFixture, (d) => (d.takes = 3)) },
  { name: "asset spec: negative seed", schema: assetSpecSchema, value: edit(assetSpecFixture, (d) => (d.seed = -1)) },

  // Take and verdict.
  { name: "take: attempt zero", schema: takeSchema, value: edit(take1Fixture, (d) => (d.attempt = 0)) },
  { name: "take: promptHash is not a sha256", schema: takeSchema, value: edit(take1Fixture, (d) => (d.promptHash = "abc")) },
  { name: "take: negative cost", schema: takeSchema, value: edit(take1Fixture, (d) => (d.costUsd = -1)) },
  { name: "take: wrong schema literal", schema: takeSchema, value: edit(take1Fixture, (d) => (d.schema = "meridian.take/v0")) },
  { name: "verdict: passes with a failing check", schema: takeVerdictSchema, value: edit(takeVerdictFixture, (d) => (d.checks[0].pass = false)) },
  { name: "verdict: no checks at all", schema: takeVerdictSchema, value: edit(takeVerdictFixture, (d) => (d.checks = [])) },
  { name: "verdict: confidence above 1", schema: takeVerdictSchema, value: edit(takeVerdictFixture, (d) => (d.confidence = 1.2)) },

  // EDL: literal fps, width, masterLufs, seed, music ducking, clip span.
  { name: "edl: fps 60", schema: edlSchema, value: edit(edlFixture, (d) => (d.fps = 60)) },
  { name: "edl: masterLufs -16", schema: edlSchema, value: edit(edlFixture, (d) => (d.audio.masterLufs = -16)) },
  { name: "edl: negative seed", schema: edlSchema, value: edit(edlFixture, (d) => (d.seed = -5)) },
  { name: "edl: music without duckDb", schema: edlSchema, value: edit(edlFixture, (d) => delete d.audio.music.duckDb) },
  { name: "edl: clip ends before it starts", schema: edlSchema, value: edit(edlFixture, (d) => (d.tracks[1].clips[0].endMs = 1000)) },
  { name: "edl: negative effect time", schema: edlSchema, value: edit(edlFixture, (d) => (d.effects[0].atMs = -1)) },

  // Gate results: the pass flag follows the checks; unknown gate ids are refused.
  { name: "gate: passes with a failing check", schema: gateResultSchema, value: edit(gateResultFixture, (d) => (d.checks[0].pass = false)) },
  { name: "gate: unknown gate id", schema: gateResultSchema, value: edit(gateResultFixture, (d) => (d.gate = "lint")) },
  { name: "gate: no checks", schema: gateResultSchema, value: edit(gateResultFixture, (d) => (d.checks = [])) },

  // Review: post_render only, passing review has no failures.
  { name: "review: result gate is not post_render", schema: reviewResultSchema, value: edit(reviewResultFixture, (d) => (d.result.gate = "take")) },
  { name: "review: passes with a failure listed", schema: reviewResultSchema, value: edit(reviewResultFixture, (d) => d.failures.push({ rule: "black_frames" })) },
  { name: "review: failure names a take id as its shot", schema: reviewResultSchema, value: edit(reviewResultFixture, (d) => { d.result.pass = false; d.result.checks[0].pass = false; d.failures.push({ rule: "black_frames", shotId: ID.take1 }); }) },

  // Composition: root file, hash, duplicate paths, traversal.
  { name: "composition: root file is main.html", schema: compositionSchema, value: edit(compositionFixture, (d) => (d.rootFile = "main.html")) },
  { name: "composition: hash does not match its files", schema: compositionSchema, value: edit(compositionFixture, (d) => (d.contentHash = "sha256:" + "0".repeat(64))) },
  { name: "composition: duplicate file path", schema: compositionSchema, value: edit(compositionFixture, (d) => d.files.push({ ...d.files[0] })) },
  { name: "composition: path escapes the folder", schema: compositionSchema, value: edit(compositionFixture, (d) => (d.files[1].path = "../secret.html")) },

  // Rendered video: idempotency key shape, money.
  { name: "render: idempotency key is not a hash", schema: renderedVideoSchema, value: edit(renderedVideoFixture, (d) => (d.idempotencyKey = "cmp-1")) },
  { name: "render: cost with five decimals", schema: renderedVideoSchema, value: edit(renderedVideoFixture, (d) => (d.costUsd = 0.04712)) },
  { name: "render: zero bytes", schema: renderedVideoSchema, value: edit(renderedVideoFixture, (d) => (d.bytes = 0)) },

  // Manifest: cost arithmetic, timings, attempts, literal schema.
  { name: "manifest: total does not add up", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.cost.total = 2)) },
  { name: "manifest: negative stage timing", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.timings.render = -4)) },
  { name: "manifest: zero attempts", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.shots[0].attempts = 0)) },
  { name: "manifest: unknown gate in gates", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.gates[0].gate = "lint")) },

  // Manifest v2 (engine-contracts@3): the schema literal and the optional role calls.
  { name: "manifest: the v1 literal is refused now", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.schema = "meridian.manifest/v1")) },
  { name: "manifest: role call outside the Bible 11.1 list", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.roleCalls[0].role = "copywriter")) },
  {
    name: "manifest: role call with another role's prompt version",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => (d.roleCalls[0].promptVersion = "critic_take@1")),
  },
  {
    name: "manifest: role call whose prompt version is not recorded in promptVersions",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => {
      delete d.promptVersions.planner;
    }),
  },
  {
    name: "manifest: role call prompt version differs from promptVersions",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => (d.promptVersions.planner = "planner@2")),
  },
  {
    name: "manifest: unknown cost not flagged as an estimate",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => (d.roleCalls[2].actualIsEstimate = false)),
  },
  {
    name: "manifest: invalid answer held as a bill",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => {
      d.roleCalls[2].costUsd = 0.04;
      d.roleCalls[2].actualIsEstimate = false;
    }),
  },
  {
    name: "manifest: negative prompt token count",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => (d.roleCalls[0].tokens.prompt = -1)),
  },
  { name: "manifest: role call verdict outside the journal's two", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.roleCalls[0].verdict = "refused")) },
  { name: "manifest: role call cost with five decimals", schema: manifestSchema, value: edit(manifestFixture, (d) => (d.roleCalls[0].costUsd = 0.14201)) },
  {
    name: "manifest: role call without its model",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => {
      delete d.roleCalls[0].model;
    }),
  },
  {
    name: "manifest: role call without its tokens object",
    schema: manifestSchema,
    value: edit(manifestFixture, (d) => {
      delete d.roleCalls[0].tokens;
    }),
  },

  // Budget reservation and ledger entry.
  { name: "reservation: paused without a reason", schema: budgetReservationSchema, value: edit(budgetReservationFixture, (d) => (d.state = "paused")) },
  { name: "reservation: estimate differs from the lines", schema: budgetReservationSchema, value: edit(budgetReservationFixture, (d) => (d.estimateUsd = 0.5)) },
  { name: "reservation: unknown mode", schema: budgetReservationSchema, value: edit(budgetReservationFixture, (d) => (d.mode = "turbo")) },
  { name: "reservation: led prefix on a reservation", schema: budgetReservationSchema, value: edit(budgetReservationFixture, (d) => (d.reservationId = ID.ledgerRender)) },
  { name: "ledger: entryId with the res prefix", schema: ledgerEntrySchema, value: edit(ledgerRenderFixture, (d) => (d.entryId = ID.reservation)) },
  { name: "ledger: estimate flag without an actual", schema: ledgerEntrySchema, value: edit(ledgerRenderFixture, (d) => { delete d.actualUsd; d.actualIsEstimate = true; }) },
  { name: "ledger: negative estimate", schema: ledgerEntrySchema, value: edit(ledgerRenderFixture, (d) => (d.estimateUsd = -0.05)) },
  { name: "ledger: missing idempotency key", schema: ledgerEntrySchema, value: without(ledgerRenderFixture, "idempotencyKey") },
  { name: "ledger: role without a prompt version", schema: ledgerEntrySchema, value: without(ledgerClaudeFixture, "promptVersion") },
  { name: "ledger: prompt version without a role", schema: ledgerEntrySchema, value: without(ledgerClaudeFixture, "role") },
  { name: "ledger: role outside the Bible 11.1 list", schema: ledgerEntrySchema, value: edit(ledgerClaudeFixture, (d) => (d.role = "copywriter")) },
  { name: "ledger: prompt version of another role", schema: ledgerEntrySchema, value: edit(ledgerClaudeFixture, (d) => (d.promptVersion = "segmenter@1")) },
  { name: "ledger: prompt version without a number", schema: ledgerEntrySchema, value: edit(ledgerClaudeFixture, (d) => (d.promptVersion = "planner")) },
  { name: "ledger: prompt version 0", schema: ledgerEntrySchema, value: edit(ledgerClaudeFixture, (d) => (d.promptVersion = "planner@0")) },
  { name: "ledger: prompt version with a path", schema: ledgerEntrySchema, value: edit(ledgerClaudeFixture, (d) => (d.promptVersion = "planner@1/../x")) },

  // Contract v4: the frame_reader role, and the editor as a decision author (Bible L7).
  { name: "ledger: frame_reader with the planner's prompt version", schema: ledgerEntrySchema, value: edit(ledgerFrameReaderFixture, (d) => (d.promptVersion = "planner@1")) },
  { name: "ledger: frame_reader without its prompt version", schema: ledgerEntrySchema, value: without(ledgerFrameReaderFixture, "promptVersion") },
  {
    name: "manifest role call: frame_reader with the critic's prompt version",
    schema: manifestRoleCallSchema,
    value: { ...manifestRoleCallsFixture[1], role: "frame_reader", promptVersion: "critic_take@1" },
  },
  { name: "decision: author outside the four", schema: decisionSchema, value: edit(editorDecisionFixture, (d) => (d.by = "bot")) },
  { name: "decision: author in another case", schema: decisionSchema, value: edit(editorDecisionFixture, (d) => (d.by = "Editor")) },
  { name: "decision: editor decision with no reason", schema: decisionSchema, value: without(editorDecisionFixture, "reason") },
  { name: "decision: editor decision with an empty subject", schema: decisionSchema, value: edit(editorDecisionFixture, (d) => (d.at = "")) },
  {
    name: "decision: an alternative with an infinite score",
    schema: decisionSchema,
    value: edit(editorDecisionFixture, (d) => (d.alternatives[0].score = Number.POSITIVE_INFINITY)),
  },

  // Provider error and kits.
  { name: "provider error: unknown kind", schema: providerErrorSchema, value: edit(providerErrorFixture, (d) => (d.kind = "boom")) },
  { name: "provider error: retryable missing", schema: providerErrorSchema, value: without(providerErrorFixture, "retryable") },
  { name: "style kit: palette colour is a word", schema: styleKitSchema, value: edit(styleKitFixture, (d) => (d.palette.primary = "red")) },
  { name: "style kit: motion intensity 4", schema: styleKitSchema, value: edit(styleKitFixture, (d) => (d.motionIntensity = 4)) },
  { name: "style kit: caption weight 600", schema: styleKitSchema, value: edit(styleKitFixture, (d) => (d.captionStyle.weight = 600)) },
  { name: "style kit: banned type that does not exist", schema: styleKitSchema, value: edit(styleKitFixture, (d) => d.bannedTypes.push("hologram" as never)) },
  { name: "persona: only two portraits", schema: personaSchema, value: edit(personaFixture, (d) => d.portraits.splice(2)) },
  { name: "persona: not marked AI generated", schema: personaSchema, value: edit(personaFixture, (d) => ((d as { isAiGenerated: boolean }).isAiGenerated = false)) },
  { name: "character: unknown kind", schema: characterSheetSchema, value: edit(characterSheetFixture, (d) => (d.kind = "hand_drawn")) },
  { name: "product kit: hero angle top", schema: productKitSchema, value: edit(productKitFixture, (d) => (d.heroImages[0].angle = "top")) },
  { name: "voice kit: no direction", schema: voiceKitSchema, value: without(voiceKitFixture, "direction") },
  { name: "voice kit: zero words per minute", schema: voiceKitSchema, value: edit(voiceKitFixture, (d) => (d.wordsPerMinute = 0)) },
  { name: "voice kit: negative words per minute", schema: voiceKitSchema, value: edit(voiceKitFixture, (d) => (d.wordsPerMinute = -150)) },
  { name: "voice kit: words per minute as text", schema: voiceKitSchema, value: edit(voiceKitFixture, (d) => (d.wordsPerMinute = "150")) },
  { name: "voice kit: infinite words per minute", schema: voiceKitSchema, value: edit(voiceKitFixture, (d) => (d.wordsPerMinute = Number.POSITIVE_INFINITY)) },
  { name: "voice kit: NaN words per minute", schema: voiceKitSchema, value: edit(voiceKitFixture, (d) => (d.wordsPerMinute = Number.NaN)) },

  // Artifact envelope: id prefix, body literal agreement, type, time.
  { name: "envelope: artifactId with the take prefix", schema: envelopeSchema(scenePlanSchema), value: edit(scenePlanEnvelopeFixture, (d) => (d.artifactId = ID.take1)) },
  { name: "envelope: schema differs from body.schema", schema: envelopeSchema(scenePlanSchema), value: edit(scenePlanEnvelopeFixture, (d) => (d.schema = "meridian.take/v1")) },
  { name: "envelope: unknown artifact type", schema: envelopeSchema(scenePlanSchema), value: edit(scenePlanEnvelopeFixture, (d) => (d.type = "banana")) },
  { name: "envelope: createdAt is not an ISO time", schema: envelopeSchema(scenePlanSchema), value: edit(scenePlanEnvelopeFixture, (d) => (d.createdAt = "13/10/2026")) },
  { name: "envelope: content hash is not a sha256", schema: envelopeSchema(scenePlanSchema), value: edit(scenePlanEnvelopeFixture, (d) => (d.contentHash = "sha1:abc")) },
];

for (const item of cases) {
  test(`schema rejects ${item.name}`, () => {
    const result = item.schema.safeParse(item.value);
    assert.equal(result.success, false, `expected rejection for: ${item.name}`);
  });
}

test("a gate with a failing check is valid only when it says pass false", () => {
  assert.equal(gateResultSchema.safeParse(gateResultFixture).success, true);
  const failingAndSaysSo = edit(gateResultFixture, (d) => {
    d.checks[0].pass = false;
    d.pass = false;
  });
  assert.equal(gateResultSchema.safeParse(failingAndSaysSo).success, true);
});

test("a scene plan with an extra unknown field still parses and drops it", () => {
  const parsed = scenePlanSchema.parse(edit(scenePlanFixture, (d) => (d.extra = "ignored")));
  assert.equal("extra" in parsed, false);
});

test("contract v2 is additive: a voice kit without wordsPerMinute and a ledger row without role still parse", () => {
  assert.equal(voiceKitSchema.safeParse(without(voiceKitFixture, "wordsPerMinute")).success, true);
  assert.equal(ledgerEntrySchema.safeParse(without(ledgerRenderFixture, "role")).success, true);
  assert.equal(ledgerEntrySchema.safeParse(ledgerClaudeFixture).success, true);
});

test("a Claude ledger row keeps its role and prompt version through a parse", () => {
  const parsed = ledgerEntrySchema.parse(ledgerClaudeFixture);
  assert.equal(parsed.role, "planner");
  assert.equal(parsed.promptVersion, "planner@1");
});

test("contract v3 is additive for manifests: a manifest without role calls still parses as v2", () => {
  assert.equal(manifestSchema.safeParse(without(manifestFixture, "roleCalls")).success, true);
  assert.equal(manifestSchema.safeParse(edit(manifestFixture, (d) => (d.roleCalls = []))).success, true);
});

test("manifest v2: an unknown cost and an unknown token count stay null, and are never 0", () => {
  const parsed = manifestSchema.parse(manifestFixture);
  const director = parsed.roleCalls?.find((call) => call.role === "director_check");
  assert.equal(director?.costUsd, null);
  assert.equal(director?.tokens.prompt, null);
  assert.equal(director?.actualIsEstimate, true);
});
