// The cookbook library's view helpers (round 3, K19): the filter and the family list, over cards the server has already computed (K19b2).
// Imports no engine code, so the library screen can load it in the browser. The card type is imported for types only.

import { COOKBOOK_FAMILIES } from "../../lib/meridian/cookbooks/families.ts";
import type { CookbookCard, CookbookFamily } from "../../lib/meridian/cookbooks/cards.ts";

export type { CookbookCard, CookbookFamily };

export type LibraryFilter = { family: "all" | CookbookFamily; freeOnly: boolean };

export const NO_FILTER: LibraryFilter = { family: "all", freeOnly: false };

/** The cards that pass the filter, in the order given. */
export function filterCards(cards: readonly CookbookCard[], filter: LibraryFilter = NO_FILTER): CookbookCard[] {
  return cards.filter((card) => (filter.family === "all" || card.family === filter.family) && (!filter.freeOnly || card.freeInAgentMode));
}

/** The families that have at least one card, in the order the schema lists them, so the filter offers only real choices. */
export function familiesIn(cards: readonly CookbookCard[]): CookbookFamily[] {
  const present = new Set(cards.map((card) => card.family));
  return COOKBOOK_FAMILIES.filter((family) => present.has(family));
}

/** The cards that are not a factory preset or a blank start mode. The preset bar shows those already, so the bar lists these beside them (K20b1). */
export function nonFactoryCardsOf(cards: readonly CookbookCard[]): CookbookCard[] {
  return cards.filter((card) => !card.cookbookId.startsWith("ck_factory_") && !card.cookbookId.startsWith("ck_blank_"));
}
