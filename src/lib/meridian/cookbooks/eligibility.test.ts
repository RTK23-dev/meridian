// Eligibility (K9): what the inputs allow, read from each cookbook's ingredients. A paid way needs a budget above zero; an unknown budget is
// not a budget; an upload needs the file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { blankCookbook, factoryPresetCookbook } from "./builtin/factory-presets.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import { eligibilityFor, eligibilityOf, type RunInputs } from "./eligibility.ts";
import type { Cookbook } from "./schema.ts";

const NOTHING: RunInputs = {
  briefChars: 0,
  reference: { attached: false, dnaCached: false },
  productKit: false,
  uploads: { voice: false, footage: false, music: false },
  budgetUsd: null,
  runKind: "normal",
};

function presenterCookbook(): Cookbook {
  return {
    ...threeDDataExplainerCookbook,
    cookbookId: "ck_test_presenter",
    label: "Presenter",
    ingredients: [
      {
        id: "presenter",
        kind: "presenter",
        label: "Presenter",
        need: "required",
        ways: [
          { id: "avatar", label: "AI presenter", modelClass: "avatar" },
          { id: "upload", label: "My footage", upload: true },
        ],
      },
    ],
    modes: ["agent", "engine"],
  };
}

test("the free 3D explainer is eligible with no inputs, in agent mode and engine mode", () => {
  const result = eligibilityFor(threeDDataExplainerCookbook, NOTHING);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.modes, ["agent", "engine"]);
});

test("a presenter cookbook needs footage or a budget: with neither, it is refused and says why", () => {
  const result = eligibilityFor(presenterCookbook(), NOTHING);
  assert.equal(result.eligible, false);
  assert.match(result.reasons[0] ?? "", /^Presenter: /);
  assert.match(result.reasons[0] ?? "", /no budget is set/);
});

test("with the person's footage, the presenter cookbook runs in agent mode, since the upload is free", () => {
  const result = eligibilityFor(presenterCookbook(), { ...NOTHING, uploads: { voice: false, footage: true, music: false } });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.modes, ["agent", "engine"]);
});

test("with a budget and no footage, the presenter cookbook runs in engine mode only: its ways cost money", () => {
  const result = eligibilityFor(presenterCookbook(), { ...NOTHING, budgetUsd: 50 });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.modes, ["engine"]);
});

test("a budget of zero, or an unset budget, is not a budget", () => {
  assert.equal(eligibilityFor(presenterCookbook(), { ...NOTHING, budgetUsd: 0 }).eligible, false);
  assert.equal(eligibilityFor(presenterCookbook(), { ...NOTHING, budgetUsd: null }).eligible, false);
});

test("a required reference or product kit is met only by the person's supply", () => {
  const cookbook = presenterCookbook();
  cookbook.ingredients = [
    { id: "product", kind: "product_kit", label: "Product", need: "required", ways: [{ id: "kit", label: "Product kit", upload: true }] },
  ];
  assert.equal(eligibilityFor(cookbook, NOTHING).eligible, false);
  assert.equal(eligibilityFor(cookbook, { ...NOTHING, productKit: true }).eligible, true);
});

test("a factory preset has no ingredients, so it is eligible in engine mode only", () => {
  const result = eligibilityFor(factoryPresetCookbook("viral_ugc"), NOTHING);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.modes, ["engine"]);
});

test("a blank start mode is eligible: the brief is not required", () => {
  assert.equal(eligibilityFor(blankCookbook("reference"), NOTHING).eligible, true);
});

test("the eligible cookbooks come first, in their own order", () => {
  const list = eligibilityOf([presenterCookbook(), threeDDataExplainerCookbook], NOTHING);
  assert.deepEqual(
    list.map((item) => [item.cookbookId, item.eligible]),
    [
      ["ck_3d_data_explainer", true],
      ["ck_test_presenter", false],
    ],
  );
});
