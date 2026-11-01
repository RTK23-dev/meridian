// The cookbook selector (K10), with a fake port: the answer is checked before anything is shown; an ineligible pick or an out-of-range value
// refuses the whole answer; a port that is not connected gives the picker, never a guess.

import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryPresetCookbook } from "./builtin/factory-presets.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import type { RunInputs } from "./eligibility.ts";
import { proposeCookbooks, selectorData, SELECTOR_INSTRUCTIONS, validateAnswer, type SelectorPort } from "./selector.ts";

const INPUTS: RunInputs = {
  briefChars: 120,
  reference: { attached: false, dnaCached: false },
  productKit: false,
  uploads: { voice: false, footage: false, music: false },
  budgetUsd: null,
  runKind: "normal",
};
const COOKBOOKS = [threeDDataExplainerCookbook, factoryPresetCookbook("viral_ugc")];

function port(text: string): SelectorPort {
  return async () => ({ ok: true, text });
}

test("the data the model sees carries the eligible cookbooks, in a delimited block, and no instructions", () => {
  const data = selectorData([threeDDataExplainerCookbook], INPUTS);
  assert.match(data, /^<cookbook_data>\n/);
  assert.ok(data.includes("ck_3d_data_explainer"));
  assert.equal(data.includes("Open on a surprising claim"), false, "the cookbook's instructions are not sent");
  assert.ok(SELECTOR_INSTRUCTIONS.includes("JSON only"));
});

test("a good answer is proposed, with its values, its reason and its resolution", async () => {
  const proposal = await proposeCookbooks({
    cookbooks: COOKBOOKS,
    inputs: INPUTS,
    lengthMs: 60000,
    port: port(JSON.stringify({ picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, reason: "A data story in aerial shots.", values: { pace: 1.2 } }] })),
  });
  assert.equal(proposal.status, "proposed");
  if (proposal.status !== "proposed") return;
  assert.equal(proposal.picks[0]?.values.pace, 1.2);
  assert.equal(proposal.picks[0]?.resolved.badge, "Free in agent mode");
  assert.ok(proposal.alternatives.some((ref) => ref.cookbookId === "ck_factory_viral_ugc" && typeof ref.label === "string"));
});

test("an answer naming a cookbook that was not eligible is refused whole", async () => {
  const proposal = await proposeCookbooks({
    cookbooks: COOKBOOKS,
    inputs: INPUTS,
    lengthMs: 60000,
    port: port(JSON.stringify({ picks: [{ cookbookId: "ck_nope", version: 1, reason: "x", values: {} }] })),
  });
  assert.equal(proposal.status, "refused");
  if (proposal.status === "refused") assert.ok(proposal.issues[0]?.includes("not one of the eligible cookbooks"));
});

test("a value outside its control, or a control the cookbook lacks, is refused", () => {
  const eligible = [threeDDataExplainerCookbook];
  const outOfRange = validateAnswer(JSON.stringify({ picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, reason: "x", values: { pace: 9 } }] }), eligible);
  assert.equal(outOfRange.ok, false);
  const unknown = validateAnswer(JSON.stringify({ picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, reason: "x", values: { ghost: 1 } }] }), eligible);
  assert.equal(unknown.ok, false);
});

test("an answer that is not JSON, or has the wrong shape, is refused", () => {
  assert.equal(validateAnswer("not json", [threeDDataExplainerCookbook]).ok, false);
  assert.equal(validateAnswer(JSON.stringify({ picks: [] }), [threeDDataExplainerCookbook]).ok, false);
  assert.equal(validateAnswer(JSON.stringify({ picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, reason: "x", values: {}, extra: 1 }] }), [threeDDataExplainerCookbook]).ok, false);
});

test("a port that is not connected gives the picker, with the eligible cookbooks", async () => {
  const proposal = await proposeCookbooks({ cookbooks: COOKBOOKS, inputs: INPUTS, lengthMs: 60000, port: null });
  assert.equal(proposal.status, "not_connected");
  if (proposal.status === "not_connected") assert.ok(proposal.eligible.some((ref) => ref.cookbookId === "ck_3d_data_explainer" && ref.version >= 1));
  const notConnected: SelectorPort = async () => ({ ok: false, reason: "not_connected", message: "no key" });
  assert.equal((await proposeCookbooks({ cookbooks: COOKBOOKS, inputs: INPUTS, lengthMs: 60000, port: notConnected })).status, "not_connected");
});

test("a failed call is reported as failed, not as a pick", async () => {
  const failing: SelectorPort = async () => ({ ok: false, reason: "failed", message: "the model timed out" });
  const proposal = await proposeCookbooks({ cookbooks: COOKBOOKS, inputs: INPUTS, lengthMs: 60000, port: failing });
  assert.deepEqual(proposal, { status: "failed", message: "the model timed out" });
});

test("with nothing eligible, the proposal says why and asks for nothing", async () => {
  const presenter = { ...threeDDataExplainerCookbook, cookbookId: "ck_presenter_only", ingredients: [{ id: "p", kind: "presenter" as const, label: "Presenter", need: "required" as const, ways: [{ id: "avatar", label: "AI presenter", modelClass: "avatar" as const }] }] };
  const proposal = await proposeCookbooks({ cookbooks: [presenter], inputs: INPUTS, lengthMs: 60000, port: port("{}") });
  assert.equal(proposal.status, "none");
  if (proposal.status === "none") assert.match(proposal.reasons[0] ?? "", /^Presenter: /);
});
