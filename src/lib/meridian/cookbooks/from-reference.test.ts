// A draft cookbook from a reference's measures (K25): the measured numbers become the checks, what was not measured is listed as unknown, and
// the draft validates and stays engine-only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { threeDDataExplainer } from "../../../engine/presets/three-d-data-explainer.ts";
import { draftFromMeasures } from "./from-reference.ts";

const MEASURED = threeDDataExplainer.grammar.measured as { cutsMs: number[]; shotLengthMs: { p50: number }; zoomJumps: unknown[]; patternInterruptMedianMs: number; integratedLufs: number };

test("a draft from the 3D explainer's measures validates, and its checks are the measured numbers", () => {
  const draft = draftFromMeasures({
    cookbookId: "ck_draft_3d",
    label: "Draft: 3D explainer",
    durationMs: 60009,
    measures: {
      hardCuts: MEASURED.cutsMs.length,
      firstCutMs: MEASURED.cutsMs[0],
      shotP50Ms: MEASURED.shotLengthMs.p50,
      zoomJumps: MEASURED.zoomJumps.length,
      interruptMedianMs: MEASURED.patternInterruptMedianMs,
      integratedLufs: MEASURED.integratedLufs,
    },
  });
  assert.equal(draft.ok, true, draft.ok ? "" : draft.issues.join("; "));
  if (!draft.ok) return;
  const byMeasure = Object.fromEntries(draft.cookbook.checks.map((check) => [check.measure, check.target]));
  assert.equal(byMeasure.hardCuts, 9);
  assert.equal(byMeasure.firstCutMs, 6767);
  assert.deepEqual(draft.cookbook.modes, ["engine"], "a draft is engine-only until a person reviews it");
});

test("what was not measured is listed as unknown, and no check is written for it", () => {
  const draft = draftFromMeasures({ cookbookId: "ck_draft_partial", label: "Draft", durationMs: 30000, measures: { hardCuts: 4 } });
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  assert.deepEqual(draft.cookbook.checks.map((check) => check.measure), ["hardCuts"]);
  assert.ok(draft.unknown.some((line) => line.startsWith("firstCutMs: not measured")));
  assert.ok(draft.unknown.some((line) => line.startsWith("structure:")));
  assert.ok(draft.unknown.some((line) => line.startsWith("style:")));
});

test("a draft id that is not a cookbook id is refused by the validator, not written", () => {
  const draft = draftFromMeasures({ cookbookId: "draft-bad-id", label: "Draft", durationMs: 30000, measures: {} });
  assert.equal(draft.ok, false);
});
