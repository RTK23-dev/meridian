// The library's view helpers (round 3, K19): the filter keeps only the free cards when asked, the family filter keeps one family, and the
// family list names only the families present, in schema order. The cards themselves come from the server (cards.test.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbooks } from "../../lib/meridian/cookbooks/builtin/index.ts";
import { cardsOf } from "../../lib/meridian/cookbooks/cards.ts";
import { familiesIn, filterCards, NO_FILTER, nonFactoryCardsOf } from "./library-model.ts";

const CARDS = cardsOf({ builtins: builtinCookbooks(), workspace: [] });

test("the free filter keeps only the cards that are free in agent mode", () => {
  const free = filterCards(CARDS, { family: "all", freeOnly: true });
  assert.ok(free.length > 0 && free.length < CARDS.length, "some cookbooks are free and some are not");
  assert.ok(free.every((card) => card.freeInAgentMode));
  assert.equal(filterCards(CARDS, NO_FILTER).length, CARDS.length, "no filter keeps every card");
});

test("the family filter keeps one family, and familiesIn lists only the families present, in schema order", () => {
  const families = familiesIn(CARDS);
  assert.ok(families.includes("explainer"));
  assert.deepEqual(families, ["explainer", "ugc", "product", "listicle", "story", "other"].filter((family) => families.includes(family as never)));
  const explainers = filterCards(CARDS, { family: "explainer", freeOnly: false });
  assert.ok(explainers.length > 0 && explainers.every((card) => card.family === "explainer"));
});

test("the preset bar's extra list leaves out the factory presets and the blank start modes, and keeps every other cookbook (K20b1)", () => {
  const kept = nonFactoryCardsOf(CARDS).map((card) => card.cookbookId);
  assert.ok(kept.includes("ck_3d_data_explainer"));
  assert.ok(kept.every((id) => !id.startsWith("ck_factory_") && !id.startsWith("ck_blank_")), "no factory or blank cookbook is listed twice");
  assert.equal(kept.length, CARDS.filter((card) => !card.cookbookId.startsWith("ck_factory_") && !card.cookbookId.startsWith("ck_blank_")).length);
});
