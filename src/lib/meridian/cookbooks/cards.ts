// The cookbook library's cards (round 3, K19), computed on the server (K19b2). Each card is resolved with its own default values at a standard
// length, so its badge, needs and estimate are the cookbook's words, not a guess. A cookbook that cannot be resolved on its own says why, and
// shows no number. The browser gets the cards in the library response; it never imports these rules (they need the engine).

import { defaultsOf } from "./controls.ts";
import { COOKBOOK_FAMILIES } from "./families.ts";
import { resolveCookbook } from "./resolve.ts";
import type { Cookbook } from "./schema.ts";

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

/** Every card of a brand's library: the built-in cookbooks, then the workspace ones. Each cookbook appears once, at its latest version. */
export function cardsOf(input: { builtins: readonly Cookbook[]; workspace: readonly Cookbook[] }): CookbookCard[] {
  return [...input.builtins.map((cookbook) => cardOf(cookbook, "builtin")), ...input.workspace.map((cookbook) => cardOf(cookbook, "workspace"))];
}
