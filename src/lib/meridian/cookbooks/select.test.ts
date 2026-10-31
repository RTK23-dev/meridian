// Confirming a selection (K11): a normal run waits for the person; an automated loop accepts the top pick; a change is recorded as a change,
// and a choice that is not eligible or not in the library is refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryPresetCookbook } from "./builtin/factory-presets.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import type { RunInputs } from "./eligibility.ts";
import { confirmSelection, selectionStateOf } from "./select.ts";
import type { Proposal } from "./selector.ts";

const INPUTS: RunInputs = {
  briefChars: 120,
  reference: { attached: false, dnaCached: false },
  productKit: false,
  uploads: { voice: false, footage: false, music: false },
  budgetUsd: null,
  runKind: "normal",
};
const COOKBOOKS = [threeDDataExplainerCookbook, factoryPresetCookbook("viral_ugc")];
const PROPOSAL: Proposal = {
  status: "proposed",
  picks: [
    {
      cookbookId: "ck_3d_data_explainer",
      version: 2,
      label: "3D data explainer",
      reason: "A data story in aerial shots.",
      values: { pace: 1 },
      resolved: {} as never,
    },
  ],
  alternatives: ["ck_factory_viral_ugc"],
};

test("a normal run waits for the person, and an automated loop accepts the top pick", () => {
  assert.deepEqual(selectionStateOf(PROPOSAL, "normal"), { state: "awaiting_confirmation" });
  const auto = selectionStateOf(PROPOSAL, "automated_loop");
  assert.equal(auto.state, "auto_accepted");
  if (auto.state === "auto_accepted") assert.equal(auto.record.how, "auto_accepted");
});

test("confirming the pick as proposed is recorded as confirmed", () => {
  const result = confirmSelection({ proposal: PROPOSAL, choice: { cookbookId: "ck_3d_data_explainer", version: 2 }, cookbooks: COOKBOOKS, inputs: INPUTS });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.how, "confirmed");
});

test("changing a value is recorded as a change, with the pick the selector gave", () => {
  const result = confirmSelection({
    proposal: PROPOSAL,
    choice: { cookbookId: "ck_3d_data_explainer", version: 2, values: { pace: 0.7 } },
    cookbooks: COOKBOOKS,
    inputs: INPUTS,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.how, "changed");
    assert.equal(result.record.values.pace, 0.7);
    assert.equal(result.record.proposedCookbookId, "ck_3d_data_explainer");
  }
});

test("choosing an alternative is a change; a cookbook not in the library is refused", () => {
  const alternative = confirmSelection({ proposal: PROPOSAL, choice: { cookbookId: "ck_factory_viral_ugc", version: 1 }, cookbooks: COOKBOOKS, inputs: INPUTS });
  assert.equal(alternative.ok && alternative.record.how, "changed");
  const missing = confirmSelection({ proposal: PROPOSAL, choice: { cookbookId: "ck_nope", version: 1 }, cookbooks: COOKBOOKS, inputs: INPUTS });
  assert.equal(missing.ok, false);
});

test("a value outside its control is refused, and a proposal that is not a proposal cannot be confirmed", () => {
  const bad = confirmSelection({
    proposal: PROPOSAL,
    choice: { cookbookId: "ck_3d_data_explainer", version: 2, values: { pace: 99 } },
    cookbooks: COOKBOOKS,
    inputs: INPUTS,
  });
  assert.equal(bad.ok, false);
  const none = confirmSelection({ proposal: { status: "none", reasons: [] }, choice: { cookbookId: "ck_3d_data_explainer", version: 2 }, cookbooks: COOKBOOKS, inputs: INPUTS });
  assert.equal(none.ok, false);
});
