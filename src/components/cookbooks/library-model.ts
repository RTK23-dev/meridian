// The cookbook library's view model (round 3, K19): the cards a brand's library shows, filtered by family and by "free in agent mode". Each card
// is resolved with its own default values at a standard length, so its badge, needs and estimate are the cookbook's words, not a guess. A
// cookbook that cannot be resolved on its own says why, and shows no number. Pure, so the rules are tested without a browser.

import { defaultsOf } from "../../lib/meridian/cookbooks/controls.ts";
import { resolveCookbook } from "../../lib/meridian/cookbooks/resolve.ts";
import { COOKBOOK_FAMILIES } from "../../lib/meridian/cookbooks/families.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";

/** The length a card is priced at. The person sets the real length in the detail's settings. */
export const STANDARD_LENGTH_MS = 60_000;

export type CookbookFamily = (typeof COOKBOOK_FAMILIES)[number];

export type CookbookCard = {
  cookbookId: string;
  version: number;
  label: string;
  summary: string;
  family: CookbookFamily;
  source: "builtin" | "workspace";
  /** True only when the cookbook can run in agent mode and no part of it is paid or unknown at its defaults. */
  freeInAgentMode: boolean;
  badge: string;
  needs: string[];
  /** The estimate in words: the known amount, with any unknown parts named. */
  estimate: string;
  /** Why the card cannot show its badge and estimate (a resolution failure), or null when it resolves. */
  unresolved: string | null;
};

export type LibraryFilter = { family: "all" | CookbookFamily; freeOnly: boolean };

export const NO_FILTER: LibraryFilter = { family: "all", freeOnly: false };

/** The estimate in words. An unknown part is named, never counted as zero. */
export function estimateWords(estimate: { knownUsd: number; unknown: readonly string[] }): string {
  if (estimate.unknown.length > 0) return `About $${estimate.knownUsd.toFixed(2)}, plus parts whose price is unknown`;
  return estimate.knownUsd > 0 ? `About $${estimate.knownUsd.toFixed(2)}` : "No paid parts";
}

/** One card: the cookbook at its defaults, resolved. A cookbook that does not resolve keeps its label and says why. */
export function cardOf(cookbook: Cookbook, source: "builtin" | "workspace"): CookbookCard {
  const base = { cookbookId: cookbook.cookbookId, version: cookbook.version, label: cookbook.label, summary: cookbook.summary, family: cookbook.family, source };
  const resolved = resolveCookbook(cookbook, { values: defaultsOf(cookbook.controls), lengthMs: STANDARD_LENGTH_MS });
  if (!resolved.ok) {
    return { ...base, freeInAgentMode: false, badge: "Not available yet", needs: [], estimate: "No estimate", unresolved: resolved.issues.join("; ") };
  }
  const free =
    resolved.resolved.modes.includes("agent") && resolved.resolved.estimate.unknown.length === 0 && resolved.resolved.estimate.knownUsd === 0;
  return {
    ...base,
    freeInAgentMode: free,
    badge: resolved.resolved.badge,
    needs: resolved.resolved.requirements,
    estimate: estimateWords(resolved.resolved.estimate),
    unresolved: null,
  };
}

/** The cards of a brand's library: the built-in cookbooks, then the workspace ones, filtered. Each cookbook appears once, at its latest version. */
export function cardsOf(input: { builtins: readonly Cookbook[]; workspace: readonly Cookbook[] }, filter: LibraryFilter = NO_FILTER): CookbookCard[] {
  const cards = [...input.builtins.map((cookbook) => cardOf(cookbook, "builtin")), ...input.workspace.map((cookbook) => cardOf(cookbook, "workspace"))];
  return cards.filter((card) => (filter.family === "all" || card.family === filter.family) && (!filter.freeOnly || card.freeInAgentMode));
}

/** The families that have at least one cookbook in the library, in the order the schema lists them, so the filter offers only real choices. */
export function familiesIn(cards: readonly CookbookCard[]): CookbookFamily[] {
  const present = new Set(cards.map((card) => card.family));
  return COOKBOOK_FAMILIES.filter((family) => present.has(family));
}
