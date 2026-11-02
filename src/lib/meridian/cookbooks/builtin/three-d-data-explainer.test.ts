// The 3D data explainer cookbook (K4): it validates, reads its style and grammar from the preset, and its choices change what it needs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { planNodeSchema } from "../../../../engine/orchestrator/contracts.ts";
import { threeDDataExplainer } from "../../../../engine/presets/three-d-data-explainer.ts";
import { shotCost } from "../../../../engine/plan/cost.ts";
import { resolveCookbook, type ResolvedCookbook } from "../resolve.ts";
import { validateCookbook } from "../validate.ts";
import { buildThreeDDataExplainerCookbook, threeDDataExplainerCookbook } from "./three-d-data-explainer.ts";

const LENGTH = 60000;

function resolved(values: Record<string, string | number | boolean> = {}, voiceCharacters?: number): ResolvedCookbook {
  const result = resolveCookbook(threeDDataExplainerCookbook, { values, lengthMs: LENGTH, voiceCharacters });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

test("the built-in cookbook passes validation", () => {
  const result = validateCookbook(threeDDataExplainerCookbook);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
});

test("its style and structure come from the preset, not a copy", () => {
  assert.equal(threeDDataExplainerCookbook.style?.styleKitId, threeDDataExplainer.styleKit.styleKitId);
  assert.deepEqual(
    threeDDataExplainerCookbook.grammar.structure,
    threeDDataExplainer.structure.map((beat) => ({ role: beat.role, fromMs: beat.fromMs, toMs: beat.toMs })),
  );
  assert.equal(threeDDataExplainerCookbook.version, threeDDataExplainer.version);
});

test("its checks are the reference's measured numbers", () => {
  const byMeasure = Object.fromEntries(threeDDataExplainerCookbook.checks.map((check) => [check.measure, check.target]));
  assert.equal(byMeasure.hardCuts, 9);
  assert.equal(byMeasure.firstCutMs, 6767);
  assert.equal(byMeasure.zoomJumps, 8);
});

test("with the free defaults it runs in agent mode, with no paid call, and the badge says so", () => {
  const plain = resolved();
  assert.deepEqual(plain.modes, ["agent", "engine"]);
  assert.equal(plain.badge, "Free in agent mode");
  assert.equal(plain.estimate.knownUsd, 0);
  assert.deepEqual(plain.estimate.unknown, []);
  const enabled = plain.steps.filter((step) => step.enabled).map((step) => step.id);
  assert.deepEqual(enabled, ["script", "scenes", "data_room", "hook_counter", "captions", "edit", "render"]);
  assert.ok(plain.agentBrief.includes("no paid provider call"));
});

test("turning on an AI voice-over removes agent mode and adds the voice step and its instruction", () => {
  const voice = resolved({ voice_way: "tts" });
  assert.deepEqual(voice.modes, ["engine"]);
  assert.equal(voice.steps.find((step) => step.id === "voice_over")?.enabled, true);
  assert.ok((voice.instructions.script ?? []).some((text) => text.startsWith("Write for speech")));
  assert.equal(voice.badge, "Price unknown", "the AI voice has no character count, so its price is unknown, not 0");
  const priced = resolved({ voice_way: "tts" }, 1200);
  assert.match(priced.badge, /^Paid: about \$/);
});

test("a person's own recording keeps agent mode: the upload is free", () => {
  const recorded = resolved({ voice_way: "upload" });
  assert.deepEqual(recorded.modes, ["agent", "engine"]);
  assert.equal(recorded.steps.find((step) => step.id === "voice_over")?.enabled, true);
});

test("generated aerial shots are priced by the engine's shot cost, and remove agent mode", () => {
  const generated = resolved({ scenes_way: "generated" });
  assert.deepEqual(generated.modes, ["engine"]);
  const expected = shotCost("cinematic", LENGTH);
  assert.equal(expected.known, true);
  if (expected.known) assert.equal(generated.estimate.knownUsd, Math.round(expected.totalUsd * 10000) / 10000);
});

test("the length choice sets the scenes' length from its table, and the pace reaches the scenes", () => {
  const short = resolved({ length: "30", pace: 1.2 });
  const scenes = short.steps.find((step) => step.id === "scenes");
  assert.equal(scenes?.params.length_ms, 30000);
  assert.equal(scenes?.params.pace, 1.2);
});

test("the data room and the hook counter switch off with their toggles, and the caption highlight reaches the captions", () => {
  const off = resolved({ data_panels: false, hook_counter: false, caption_highlight: "colour" });
  assert.equal(off.steps.find((step) => step.id === "data_room")?.enabled, false);
  assert.equal(off.steps.find((step) => step.id === "hook_counter")?.enabled, false);
  assert.equal(off.steps.find((step) => step.id === "captions")?.params.highlight, "colour");
});

test("the plan template is what the orchestrator accepts, and it names no step that is off", () => {
  const result = resolved({ data_panels: false });
  const ids = result.planTemplate.map((node) => node.id);
  assert.equal(ids.includes("data_room"), false);
  for (const node of result.planTemplate) {
    assert.equal(planNodeSchema.safeParse(node).success, true, node.id);
  }
});

test("a cookbook can be built from another preset of the same shape", () => {
  const other = { ...threeDDataExplainer, version: 9, label: "Other" };
  const built = buildThreeDDataExplainerCookbook(other);
  assert.equal(built.version, 9);
  assert.equal(validateCookbook(built).ok, true);
});
