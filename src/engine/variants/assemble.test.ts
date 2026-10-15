// The assembly of a variant's EDL (variants/assemble.ts): the editor builds it over the variant's own plan, voice and takes. The fixtures are the
// chain fixtures the master's edit test builds from, so the master's EDL passes the edit rules, and the variant's must too.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EditDecisionList, Take, VoiceTrack } from "../contracts/index.ts";
import {
  FIXTURE_IDS,
  fixtureId,
  scenePlanFixture,
  styleKitFixture,
  take1Fixture,
  take2Fixture,
  take3bFixture,
  validatedRequestFixture,
  videoDnaFixture,
  voiceTrackFixture,
} from "../contracts/fixtures/index.ts";
import { buildEdl } from "../edit/editor.ts";
import { emphasisOf } from "../jobs/handlers/edit.ts";
import { assembleVariantEdl } from "./assemble.ts";
import { variantScenePlan } from "./plan.ts";

const SHOT_HOOK = FIXTURE_IDS.shot1;
const VARIANT_VOICE_ID = "vtk_variant_hook";
const VARIANT_TAKE_URI = "store://takes/variant-hook.mp4";
const VARIANT_OPENING = "Hello";

const masterVoice = voiceTrackFixture as VoiceTrack;
const masterTakes: Take[] = [take1Fixture, take2Fixture, take3bFixture];

/** The variant's narration: the same track with a new first word, under its own id and audio. */
function variantVoice(): VoiceTrack {
  return {
    ...masterVoice,
    voiceTrackId: VARIANT_VOICE_ID,
    audioUri: "store://voice/variant-hook.mp3",
    words: masterVoice.words.map((word, index) => (index === 0 ? { ...word, text: VARIANT_OPENING } : word)),
  };
}

/** The variant's take of its hook shot: the master's take with its own id and media. */
function variantTake(): Take {
  return { ...take1Fixture, takeId: fixtureId("take_", 91), uri: VARIANT_TAKE_URI };
}

function buildMaster(): EditDecisionList {
  const build = buildEdl({
    requestId: FIXTURE_IDS.request,
    plan: scenePlanFixture,
    voice: masterVoice,
    grammar: videoDnaFixture.editGrammar,
    referenceDurationMs: videoDnaFixture.durationMs,
    takes: masterTakes,
    kit: styleKitFixture,
    emphasis: emphasisOf(validatedRequestFixture),
  });
  assert.equal(build.pass, true, `the master's EDL passes the edit rules: ${build.checks.filter((check) => !check.pass).map((check) => check.rule).join(", ")}`);
  if (build.edl === null) throw new Error("the master's EDL is missing");
  return build.edl;
}

function assemblyOf(takes: Take[]) {
  const plan = variantScenePlan(scenePlanFixture, { key: "hook:1", attribute: "hook", reference: null, shotIds: [SHOT_HOOK], voiceTrackId: VARIANT_VOICE_ID, chose: "hook:1" }).plan;
  return assembleVariantEdl({
    requestId: FIXTURE_IDS.request,
    masterEdlId: buildMaster().edlId,
    plan,
    voice: variantVoice(),
    dna: videoDnaFixture,
    takes,
    kit: styleKitFixture,
    emphasis: emphasisOf(validatedRequestFixture),
  });
}

describe("a variant's EDL is built over its own inputs (Bible 6.13, 6.8)", () => {
  it("builds an EDL that is a variant of the master, passes the edit rules, and plays the variant's narration and take", () => {
    const masterEdl = buildMaster();
    const result = assemblyOf([variantTake(), take2Fixture, take3bFixture]);
    assert.equal(result.status, "built", result.status === "not_built" ? result.reason : "");
    if (result.status !== "built") return;
    assert.equal(result.edl.variantOf, masterEdl.edlId, "the variant names the master EDL it varies");
    assert.notEqual(result.edlId, masterEdl.edlId, "a variant has its own EDL id");
    assert.equal(result.checks.every((check) => check.pass), true, "every edit rule passes for the variant");
    assert.equal(result.edl.audio.voice.uri, "store://voice/variant-hook.mp3", "the EDL speaks the variant's narration");
    const tracks = JSON.stringify(result.edl.tracks);
    assert.ok(tracks.includes(VARIANT_TAKE_URI), "the hook shot plays the variant's take");
    assert.equal(tracks.includes(take1Fixture.uri), false, "the master's take of the hook shot is not played");
  });

  it("captions the variant's words: the new opening is on screen, and the master's is not", () => {
    const result = assemblyOf([variantTake(), take2Fixture, take3bFixture]);
    assert.equal(result.status, "built");
    if (result.status !== "built") return;
    const captions = JSON.stringify(result.edl.tracks.filter((track) => track.layer === "captions"));
    assert.ok(captions.includes(VARIANT_OPENING), "the caption carries the variant's opening word");
    assert.equal(captions.includes(masterVoice.words[0]?.text ?? "\u0000"), false, "the master's opening word is not on screen for the variant");
  });

  it("is not built, and names the failing rules, when a shot the EDL plays has no take", () => {
    const result = assemblyOf([take2Fixture, take3bFixture]);
    assert.equal(result.status, "not_built");
    if (result.status !== "not_built") return;
    assert.match(result.reason, /did not pass the edit gate/);
    assert.ok(result.checks.some((check) => !check.pass));
  });
});
