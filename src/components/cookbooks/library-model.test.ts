// The cookbook library's cards (round 3, K19): every built-in cookbook has a card with its own badge and estimate; the free filter keeps only
// what runs in agent mode at no cost; the family filter offers the families that are present; an unknown part is named, never shown as zero.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbooks } from "../../lib/meridian/cookbooks/builtin/index.ts";
import { cardsOf, estimateWords, familiesIn, NO_FILTER, nonFactoryCardsOf } from "./library-model.ts";

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

test("the free filter keeps only the cards that are free in agent mode", () => {
  const all = cardsOf({ builtins: BUILTINS, workspace: [] }, NO_FILTER);
  const free = cardsOf({ builtins: BUILTINS, workspace: [] }, { family: "all", freeOnly: true });
  assert.ok(free.length > 0 && free.length < all.length, "some cookbooks are free and some are not");
  assert.ok(free.every((card) => card.freeInAgentMode));
});

test("the family filter keeps one family, and familiesIn lists only the families present, in schema order", () => {
  const cards = cardsOf({ builtins: BUILTINS, workspace: [] });
  const families = familiesIn(cards);
  assert.ok(families.includes("explainer"));
  assert.deepEqual(
    families,
    ["explainer", "ugc", "product", "listicle", "story", "other"].filter((family) => families.includes(family as never)),
    "the order is the schema's",
  );
  const explainers = cardsOf({ builtins: BUILTINS, workspace: [] }, { family: "explainer", freeOnly: false });
  assert.ok(explainers.length > 0 && explainers.every((card) => card.family === "explainer"));
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

test("the preset bar's extra list leaves out the factory presets and the blank start modes, and keeps every other cookbook (K20b1)", () => {
  const cards = cardsOf({ builtins: BUILTINS, workspace: [] });
  const kept = nonFactoryCardsOf(cards).map((card) => card.cookbookId);
  assert.ok(kept.includes("ck_3d_data_explainer"));
  assert.ok(kept.every((id) => !id.startsWith("ck_factory_") && !id.startsWith("ck_blank_")), "no factory or blank cookbook is listed twice");
  assert.equal(kept.length, cards.filter((card) => !card.cookbookId.startsWith("ck_factory_") && !card.cookbookId.startsWith("ck_blank_")).length);
});
