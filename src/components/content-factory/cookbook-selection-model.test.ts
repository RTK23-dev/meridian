// The selection step's view (K18): a proposed pick shows its reason, its needs and its estimate; with no pick the step says why, and when the
// selector is not connected it offers the picker instead of a guess.

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionViewOf } from "./cookbook-selection-model.ts";
import type { Proposal } from "../../lib/meridian/cookbooks/selector.ts";

const resolved = {
  requirements: ["Scenes: Coded 3D scenes (free)"],
  badge: "Free in agent mode",
  estimate: { knownUsd: 0, unknown: [] as string[] },
} as never;

test("a proposed pick shows its title, reason, needs, badge and the alternatives to switch to", () => {
  const proposal: Proposal = {
    status: "proposed",
    picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, label: "3D data explainer", reason: "A data story.", values: {}, resolved }],
    alternatives: ["ck_factory_viral_ugc"],
  };
  const view = selectionViewOf(proposal);
  assert.equal(view.state, "pick");
  if (view.state !== "pick") return;
  assert.equal(view.title, "3D data explainer");
  assert.equal(view.reason, "A data story.");
  assert.deepEqual(view.needs, ["Scenes: Coded 3D scenes (free)"]);
  assert.equal(view.badge, "Free in agent mode");
  assert.equal(view.estimate, "No paid parts");
  assert.deepEqual(view.alternatives, ["ck_factory_viral_ugc"]);
});

test("an estimate with unknown parts says so, rather than showing the known part as the whole", () => {
  const unknown = { requirements: [], badge: "Price unknown", estimate: { knownUsd: 4.5, unknown: ["Voice: price unknown"] } } as never;
  const view = selectionViewOf({ status: "proposed", picks: [{ cookbookId: "ck_x", version: 1, label: "X", reason: "r", values: {}, resolved: unknown }], alternatives: [] });
  assert.equal(view.state === "pick" && view.estimate, "About $4.50, plus parts whose price is unknown");
});

test("with nothing eligible, the step says why; with the selector not connected, it offers the picker", () => {
  const none = selectionViewOf({ status: "none", reasons: ["Presenter: no budget is set"] });
  assert.equal(none.state, "none");
  if (none.state === "none") assert.deepEqual(none.reasons, ["Presenter: no budget is set"]);
  const picker = selectionViewOf({ status: "not_connected", eligible: ["ck_a", "ck_b"], message: "Pick a cookbook." });
  assert.equal(picker.state, "picker");
  if (picker.state === "picker") assert.deepEqual(picker.options, ["ck_a", "ck_b"]);
});

test("a failed call and a refused answer are each shown as what they are", () => {
  assert.equal(selectionViewOf({ status: "failed", message: "timed out" }).state, "failed");
  const refused = selectionViewOf({ status: "refused", issues: ["picks[0]: nope"] });
  assert.equal(refused.state, "refused");
  if (refused.state === "refused") assert.deepEqual(refused.issues, ["picks[0]: nope"]);
});
