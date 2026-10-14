// Types shared by the five steps of the visual decision engine (Bible section 7). Types only; no logic.

import type { BeatRole, ReferenceShotType, VisualType } from "../contracts/index.ts";
import type { VisualProperty } from "./tables.ts";

/** One visual request of a beat after Claude's classification (7.3). The classification is an input here. */
export type ClassifiedRequest = {
  strength: "must" | "may";
  want: string;
  properties: readonly VisualProperty[];
};

/** One shot to decide. The caller aligns shots to the reference (6.4 step 1) and sets the shot flags (7.2). */
export type ShotInput = {
  shotId: string;
  beatId: string;
  beatRole: BeatRole;
  /** The example's shot type at this position in the reference (7.4). */
  refShot: ReferenceShotType;
  startMs: number;
  endMs: number;
  flags: {
    /** Legible text would have to sit inside generated pixels (7.2 rule 3). */
    textInPixels: boolean;
    /** Hands would manipulate the product in generated video (7.2 rule 4). */
    handsOnProduct: boolean;
    /** The beat shows the product (7.2 rule 2). A real_product must also sets this. */
    showsProduct: boolean;
  };
  /** The visual requests of this shot's beat. */
  requests: readonly ClassifiedRequest[];
};

/** Which kits the request resolved (13). Missing kits make the types that need them unavailable (7.2 rule 6). */
export type PlanKits = {
  persona: boolean;
  rigCharacter: boolean;
  generatedCharacter: boolean;
  productKit: boolean;
};

export type CandidateOrigin = "proposal" | "may" | "must" | "downgrade";

/** A type in the candidate pool of one shot. proposalIndex is the position in the 7.4 list, else null. */
export type Candidate = {
  visualType: VisualType;
  origin: CandidateOrigin;
  proposalIndex: number | null;
};

export const RULE_IDS = [
  "rule1_must",
  "rule2_product_pixels",
  "rule3_text_in_pixels",
  "rule4_hands_on_product",
  "rule5_budget",
  "rule6_kit",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Why one candidate was removed from one shot (kept for the audit trail). */
export type Rejection = {
  visualType: VisualType;
  rule: RuleId;
  detail: string;
};
