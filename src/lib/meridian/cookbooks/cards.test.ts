// The cookbook cards (round 3, K19b2), computed on the server: every built-in has a card with its badge and estimate; the explainer is free
// in agent mode at its defaults; workspace copies come after the built-ins and keep their source; an unknown part is named, never zero.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbooks } from "./builtin/index.ts";
import { cardsOf, estimateWords } from "./cards.ts";

const BUILTINS = builtinCookbooks();

test("every built-in cookbook has a card, with its label, its badge and its estimate in words", () => {
  const cards = cardsOf({ builtins: BUILTINS, workspace: [] });
  assert.equal(cards.length, BUILTINS.length);
  for (const card of cards) {
    assert.equal(card.source, "builtin");
    assert.ok(card.label.length > 0, `${card.cookbookId} has a label`);
    assert.ok(card.badge.length > 0, `${card.cookbookId} has a badge`);
    assert.ok(card.estimate.length > 0, `${card.cookbookId} has an estimate`);
  }
});

test("the 3D data explainer, at its defaults (coded scenes, no voice, no music), is free in agent mode", () => {
  const explainer = cardsOf({ builtins: BUILTINS, workspace: [] }).find((card) => card.cookbookId === "ck_3d_data_explainer");
  assert.ok(explainer, "the explainer has a card");
  assert.equal(explainer.freeInAgentMode, true);
  assert.equal(explainer.estimate, "No paid parts");
});

test("workspace cookbooks are added after the built-ins, and keep their source", () => {
  const [first] = BUILTINS;
  assert.ok(first);
  const copy = { ...first, cookbookId: "ck_workspace_copy", scope: "workspace" as const, label: "My copy" };
  const cards = cardsOf({ builtins: BUILTINS, workspace: [copy] });
  const last = cards[cards.length - 1];
  assert.equal(last?.cookbookId, "ck_workspace_copy");
  assert.equal(last?.source, "workspace");
});

test("an unknown part is named and never shown as zero: the estimate says the price is unknown", () => {
  assert.equal(estimateWords({ knownUsd: 0, unknown: [] }), "No paid parts");
  assert.equal(estimateWords({ knownUsd: 4.5, unknown: [] }), "About $4.50");
  assert.equal(estimateWords({ knownUsd: 4.5, unknown: ["Voice: price unknown"] }), "About $4.50, plus parts whose price is unknown");
  assert.equal(estimateWords({ knownUsd: 0, unknown: ["Voice: price unknown"] }), "About $0.00, plus parts whose price is unknown");
});
