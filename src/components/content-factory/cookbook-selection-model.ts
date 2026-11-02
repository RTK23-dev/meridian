// The selection step's view model (round 3, K18): a proposal from the cookbook selector, turned into what the hub shows. Pure, so the rules
// are tested without a browser. The step shows one pick with its reason, what it needs and what it costs, two alternatives, and the words for
// the cases where there is no pick: nothing can run, or the selector is not connected (the person picks from the list instead). Every choice
// the step offers names a cookbook by its id and version, and its label is what the person reads.

import type { Control, ControlValue } from "../../lib/meridian/cookbooks/controls.ts";
import type { CookbookRef, Proposal } from "../../lib/meridian/cookbooks/selector.ts";

export type ChoiceToSend = { cookbookId: string; version: number; values: Record<string, ControlValue> };

export type SelectionView =
  | {
      state: "pick";
      title: string;
      reason: string;
      needs: string[];
      badge: string;
      estimate: string;
      alternatives: CookbookRef[];
      confirmLabel: string;
      /** The first pick, with the values its proposal resolved: what the confirm button sends. */
      confirm: ChoiceToSend;
      /** The first pick's controls, for the settings the person may change before confirming (K18d). */
      controls: Control[];
    }
  | { state: "picker"; message: string; options: CookbookRef[] }
  | { state: "none"; message: string; reasons: string[] }
  | { state: "failed"; message: string }
  | { state: "refused"; message: string; issues: string[] };

/** What the step shows for a proposal. The first pick is the one the person is asked to confirm. */
/** The estimate in words: the known dollars, and that some parts have no known price (K17 shares this with the live update). */
export function estimateTextOf(estimate: { knownUsd: number; unknown: readonly string[] }): string {
  if (estimate.unknown.length > 0) return `About $${estimate.knownUsd.toFixed(2)}, plus parts whose price is unknown`;
  return estimate.knownUsd > 0 ? `About $${estimate.knownUsd.toFixed(2)}` : "No paid parts";
}

export function selectionViewOf(proposal: Proposal): SelectionView {
  switch (proposal.status) {
    case "proposed": {
      const top = proposal.picks[0];
      if (top === undefined) return { state: "refused", message: "The selector gave no pick.", issues: [] };
      const estimate = estimateTextOf(top.resolved.estimate);
      return {
        state: "pick",
        title: top.label,
        reason: top.reason,
        needs: top.resolved.requirements,
        badge: top.resolved.badge,
        estimate,
        alternatives: proposal.alternatives,
        confirmLabel: "Use this cookbook",
        confirm: { cookbookId: top.cookbookId, version: top.version, values: top.values },
        controls: top.controls,
      };
    }
    case "not_connected":
      return {
        state: "picker",
        message: proposal.message,
        options: proposal.eligible,
      };
    case "none":
      return {
        state: "none",
        message: "No cookbook can run with these inputs yet.",
        reasons: proposal.reasons,
      };
    case "failed":
      return { state: "failed", message: proposal.message };
    case "refused":
      return { state: "refused", message: "The selector's answer was not used, because it broke a rule.", issues: proposal.issues };
  }
}
