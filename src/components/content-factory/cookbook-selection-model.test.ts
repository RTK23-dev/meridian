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
    picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, label: "3D data explainer", reason: "A data story.", values: {}, controls: [], resolved }],
    alternatives: [{ cookbookId: "ck_factory_viral_ugc", version: 1, label: "Viral UGC" }],
  };
  const view = selectionViewOf(proposal);
  assert.equal(view.state, "pick");
  if (view.state !== "pick") return;
  assert.equal(view.title, "3D data explainer");
  assert.equal(view.reason, "A data story.");
  assert.deepEqual(view.needs, ["Scenes: Coded 3D scenes (free)"]);
  assert.equal(view.badge, "Free in agent mode");
  assert.equal(view.estimate, "No paid parts");
  assert.deepEqual(view.alternatives, [{ cookbookId: "ck_factory_viral_ugc", version: 1, label: "Viral UGC" }]);
});

test("an estimate with unknown parts says so, rather than showing the known part as the whole", () => {
  const unknown = { requirements: [], badge: "Price unknown", estimate: { knownUsd: 4.5, unknown: ["Voice: price unknown"] } } as never;
  const view = selectionViewOf({ status: "proposed", picks: [{ cookbookId: "ck_x", version: 1, label: "X", reason: "r", values: {}, controls: [], resolved: unknown }], alternatives: [] });
  assert.equal(view.state === "pick" && view.estimate, "About $4.50, plus parts whose price is unknown");
});

test("with nothing eligible, the step says why; with the selector not connected, it offers the picker", () => {
  const none = selectionViewOf({ status: "none", reasons: ["Presenter: no budget is set"] });
  assert.equal(none.state, "none");
  if (none.state === "none") assert.deepEqual(none.reasons, ["Presenter: no budget is set"]);
  const picker = selectionViewOf({
    status: "not_connected",
    eligible: [
      { cookbookId: "ck_a", version: 1, label: "Alpha" },
      { cookbookId: "ck_b", version: 3, label: "Beta" },
    ],
    message: "Pick a cookbook.",
  });
  assert.equal(picker.state, "picker");
  if (picker.state === "picker") assert.deepEqual(picker.options, [
    { cookbookId: "ck_a", version: 1, label: "Alpha" },
    { cookbookId: "ck_b", version: 3, label: "Beta" },
  ]);
});

test("a failed call and a refused answer are each shown as what they are", () => {
  assert.equal(selectionViewOf({ status: "failed", message: "timed out" }).state, "failed");
  const refused = selectionViewOf({ status: "refused", issues: ["picks[0]: nope"] });
  assert.equal(refused.state, "refused");
  if (refused.state === "refused") assert.deepEqual(refused.issues, ["picks[0]: nope"]);
});

test("the confirm button sends the top pick at its version, with the values its proposal resolved (K18c)", () => {
  const view = selectionViewOf({
    status: "proposed",
    picks: [
      { cookbookId: "ck_3d_data_explainer", version: 2, label: "3D data explainer", reason: "A data story.", values: { pace: 1.2 }, controls: [], resolved },
      { cookbookId: "ck_factory_viral_ugc", version: 1, label: "Viral UGC", reason: "Second.", values: {}, controls: [], resolved },
    ],
    alternatives: [{ cookbookId: "ck_factory_viral_ugc", version: 1, label: "Viral UGC" }],
  });
  assert.equal(view.state, "pick");
  if (view.state !== "pick") return;
  assert.deepEqual(view.confirm, { cookbookId: "ck_3d_data_explainer", version: 2, values: { pace: 1.2 } });
});

test("the first pick carries its cookbook's controls, so the step can draw the settings the person may change (K18d)", () => {
  const control = { id: "pace", kind: "slider", label: "Pace", help: null, default: 1, min: 0.5, max: 2, step: 0.1, unit: null } as never;
  const view = selectionViewOf({ status: "proposed", picks: [{ cookbookId: "ck_x", version: 1, label: "X", reason: "r", values: {}, controls: [control], resolved: { requirements: [], badge: "Free", estimate: { knownUsd: 0, unknown: [] } } as never }], alternatives: [] });
  assert.equal(view.state === "pick" && view.controls.length, 1);
  assert.equal(view.state === "pick" && view.controls[0]?.id, "pace");
});
