// The intake decision for a brief request (contract v8): the request's own checks run on the brief's text and sources, its length is an
// estimate from the brief's words, its format minimum is left to write_script, and a brief that names beats is refused (the beats do not
// exist yet). A script request is unchanged. Pure: decideIntake takes the request and the kits as data.

import assert from "node:assert/strict";
import test from "node:test";
import type { ProductionRequest } from "../../contracts/index.ts";
import {
  characterSheetFixture,
  personaFixture,
  productionRequestBriefFixture,
  productionRequestFixture,
  productKitFixture,
  styleKitFixture,
  voiceKitFixture,
} from "../../contracts/fixtures/index.ts";
import { decideIntake, briefSpeechEstimateMs, type IntakeDecisionInput } from "./intake.ts";

const KITS: IntakeDecisionInput["kits"] = {
  styleKit: styleKitFixture,
  persona: personaFixture,
  voice: voiceKitFixture,
  characters: [characterSheetFixture],
  productKit: productKitFixture,
};

const BLENDER_CLASS = { beatId: "b3", want: "the blender on a clean kitchen counter", properties: ["real_product"] as const };

function decide(request: ProductionRequest) {
  return decideIntake({ request, kits: KITS, videoDnaId: null, classifications: [BLENDER_CLASS] });
}

function checkOf(gate: { checks: Array<{ rule: string; pass: boolean; detail?: string }> }, rule: string) {
  return gate.checks.find((check) => check.rule === rule);
}

test("a brief with no visual requests passes intake's own checks, and its length is estimated from the brief's words", () => {
  const decision = decide(productionRequestBriefFixture);
  assert.equal(decision.gate.pass, true, JSON.stringify(decision.gate.checks.filter((check) => !check.pass)));
  assert.equal(decision.estimatedSpeechMs, briefSpeechEstimateMs(productionRequestBriefFixture.brief?.text ?? "", 150));
  assert.match(checkOf(decision.gate, "speech_length_estimated")?.detail ?? "", /estimated from the brief's words/);
});

test("a brief's format minimum is not an intake check: write_script computes it from the written beats", () => {
  const decision = decide(productionRequestBriefFixture);
  assert.equal(decision.minimum, null);
  assert.equal(checkOf(decision.gate, "budget_above_format_minimum"), undefined, "no minimum check runs at intake for a brief");
  assert.equal(checkOf(decision.gate, "format_minimum_computed"), undefined);
});

test("a brief that names a beat in its visual requests fails intake: the beat does not exist until the script is written", () => {
  const request: ProductionRequest = {
    ...productionRequestBriefFixture,
    visualRequests: [{ beatId: "b1", want: "the blender on a clean counter", strength: "may" }],
  };
  const decision = decide(request);
  assert.equal(decision.gate.pass, false);
  assert.match(checkOf(decision.gate, "every_must_deliverable")?.detail ?? "", /names beat b1, which a brief does not have/);
});

test("a brief whose text names a forbidden product term fails the forbidden-terms check, from the brief itself", () => {
  const forbidden = productKitFixture.forbidden[0];
  assert.ok(forbidden, "the product kit forbids at least one term");
  const request: ProductionRequest = {
    ...productionRequestBriefFixture,
    brief: { ...productionRequestBriefFixture.brief!, text: `A reel that says the product ${forbidden} everything.` },
  };
  const decision = decide(request);
  assert.equal(checkOf(decision.gate, "forbidden_terms_absent")?.pass, false);
});

test("a script request is unchanged: its length and its minimum come from its beats", () => {
  const decision = decide(productionRequestFixture);
  assert.equal(decision.gate.pass, true, JSON.stringify(decision.gate.checks.filter((check) => !check.pass)));
  assert.ok(decision.minimum !== null, "a script request has a minimum computed at intake");
  assert.equal(checkOf(decision.gate, "budget_above_format_minimum")?.pass, true);
});

test("a brief with no words per minute stops with its speech length unknown, and nothing is estimated", () => {
  const decision = decideIntake({
    request: productionRequestBriefFixture,
    kits: { ...KITS, persona: undefined, voice: undefined },
    videoDnaId: null,
    classifications: [BLENDER_CLASS],
  });
  assert.equal(decision.estimatedSpeechMs, null);
  assert.equal(decision.validated, null);
  assert.equal(checkOf(decision.gate, "speech_length_estimated")?.pass, false);
});
