// Step 1 of the visual decision engine: filter the candidates with the six hard rules (Bible 7.2), and map the `must`
// requests to the types that can deliver them (7.3). Pure code.

import { VISUAL_TYPES, type VisualType } from "../contracts/index.ts";
import { shotCost, usdAtMost, type KnownShotCost } from "./cost.ts";
import { KIT_REQUIREMENTS, PRODUCT_PIXEL_RISK, PROPERTY_TYPES, isGeneratedType, type KitNeed } from "./tables.ts";
import type { Candidate, ClassifiedRequest, PlanKits, Rejection } from "./types.ts";

/**
 * The types a shot's `must` requests allow (7.3). Each must keeps the types that can deliver every one of its
 * properties; several musts on one beat keep the types that satisfy all of them. Null when the beat has no must.
 * A must with no properties allows nothing, so it can never be satisfied (unknown means fail).
 */
export function mustAllowedTypes(requests: readonly ClassifiedRequest[]): VisualType[] | null {
  const musts = requests.filter((request) => request.strength === "must");
  if (musts.length === 0) {
    return null;
  }
  let allowed = new Set<VisualType>(VISUAL_TYPES);
  for (const must of musts) {
    if (must.properties.length === 0) {
      return [];
    }
    for (const property of must.properties) {
      const deliverable = new Set<VisualType>(PROPERTY_TYPES[property]);
      allowed = new Set([...allowed].filter((visualType) => deliverable.has(visualType)));
    }
  }
  return VISUAL_TYPES.filter((visualType) => allowed.has(visualType));
}

/** True when a must in this beat names the real product, so the beat shows it (7.2 rule 2 applies). */
export function mustShowsProduct(requests: readonly ClassifiedRequest[]): boolean {
  return requests.some((request) => request.strength === "must" && request.properties.includes("real_product"));
}

export type FilterInput = {
  candidates: readonly Candidate[];
  kits: PlanKits;
  /** Budget left for shots (cost.ts shotRoomUsd). */
  remainingUsd: number;
  durationMs: number;
  mustAllowed: readonly VisualType[] | null;
  showsProduct: boolean;
  textInPixels: boolean;
  handsOnProduct: boolean;
};

export type FilteredCandidate = Candidate & { cost: KnownShotCost };

export type FilterResult = {
  kept: FilteredCandidate[];
  rejected: Rejection[];
};

function missingKits(needs: readonly KitNeed[], kits: PlanKits): KitNeed[] {
  return needs.filter((need) => !kits[need]);
}

/**
 * Apply the six rules (7.2) to each candidate, in rule order. The first rule that removes a candidate is recorded.
 * Kept candidates keep their pool order. A candidate with an unknown price is removed by rule 5, never priced at 0.
 */
export function filterCandidates(input: FilterInput): FilterResult {
  const kept: FilteredCandidate[] = [];
  const rejected: Rejection[] = [];

  for (const candidate of input.candidates) {
    const visualType = candidate.visualType;
    const reject = (rule: Rejection["rule"], detail: string): void => {
      rejected.push({ visualType, rule, detail });
    };

    // Rule 1: a must request keeps only the types that can deliver it (7.3).
    if (input.mustAllowed !== null && !input.mustAllowed.includes(visualType)) {
      reject("rule1_must", `the must request allows only ${input.mustAllowed.join(", ") || "no type"}`);
      continue;
    }

    // Rule 2: a shot that shows the product must not generate it without a pinned hero image.
    const productRisk = PRODUCT_PIXEL_RISK[visualType];
    const pinned = input.kits.productKit;
    if (input.showsProduct && productRisk === "always") {
      reject("rule2_product_pixels", "would generate the product without the hero image");
      continue;
    }
    if (input.showsProduct && productRisk === "unless_pinned" && !pinned) {
      reject("rule2_product_pixels", "would generate the product without a pinned hero image");
      continue;
    }

    // Rule 3: legible text is never generated; it is a graphics layer.
    if (input.textInPixels && isGeneratedType(visualType)) {
      reject("rule3_text_in_pixels", "the shot needs legible text, and generated pixels cannot carry it");
      continue;
    }

    // Rule 4: hands on the product are not generated.
    if (input.handsOnProduct && isGeneratedType(visualType)) {
      reject("rule4_hands_on_product", "the shot needs hands on the product, and generated video cannot show it");
      continue;
    }

    // Rule 5: the cheapest cost must fit the remaining budget. An unknown price removes the candidate.
    const cost = shotCost(visualType, input.durationMs);
    if (!cost.known) {
      reject("rule5_budget", `unknown price: ${cost.reason}`);
      continue;
    }
    if (!usdAtMost(cost.totalUsd, input.remainingUsd)) {
      reject("rule5_budget", `costs ${cost.totalUsd} USD, above the remaining ${input.remainingUsd} USD`);
      continue;
    }

    // Rule 6: the persona, character or product kit the type needs must exist.
    const missing = missingKits(KIT_REQUIREMENTS[visualType], input.kits);
    if (missing.length > 0) {
      reject("rule6_kit", `the kit it needs is missing: ${missing.join(", ")}`);
      continue;
    }

    kept.push({ ...candidate, cost });
  }

  return { kept, rejected };
}
