// Step 1 of the visual decision engine: filter the candidates with the six hard rules (Bible 7.2), and map the `must`
// requests to the types that can deliver them (7.3). Pure code.

import { VISUAL_TYPES, type VisualType } from "../contracts/index.ts";
import { closingComponentProblem } from "./chains.ts";
import { shotCost, usdAtMost, type KnownShotCost } from "./cost.ts";
import { BUILD_GAPS, KIT_REQUIREMENTS, PRODUCT_PIXEL_RISK, PROPERTY_TYPES, isGeneratedType, type KitNeed } from "./tables.ts";
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
  /**
   * Types this shot cannot be built as, with the reason: for example a component whose text limit the shot's words exceed
   * (align.ts). Rule 6 removes them, with the kit and build-gap reasons.
   */
  refusals?: Partial<Record<VisualType, string>>;
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
 * Rule 2 (7.2): a shot that shows the product must not generate it without a pinned hero image. Returns the reason the
 * type is removed, or null when it stays. Shared with the minimum (minimum.ts), so the two cannot drift.
 */
export function productPixelRejection(visualType: VisualType, showsProduct: boolean, productKitPinned: boolean): string | null {
  // L8: a product beat shows real product imagery. Stock footage carries none, so it cannot serve a product beat.
  if (showsProduct && visualType === "stock_footage") {
    return "a product beat cannot use stock footage, which carries no real product imagery (L8)";
  }
  const productRisk = PRODUCT_PIXEL_RISK[visualType];
  if (showsProduct && productRisk === "always") {
    return "would generate the product without the hero image";
  }
  if (showsProduct && productRisk === "unless_pinned" && !productKitPinned) {
    return "would generate the product without a pinned hero image";
  }
  return null;
}

/**
 * Rule 6 (7.2), as extended in E3: the persona, character or product kit the type needs must exist, and a source for the
 * type must be buildable (BUILD_GAPS). Returns the reason the type is removed, or null when it stays. Shared with the
 * minimum (minimum.ts), so the two cannot drift.
 */
export function kitRejection(visualType: VisualType, kits: PlanKits): string | null {
  const gap = BUILD_GAPS[visualType];
  if (gap !== undefined) {
    return `no source can be built for it yet: ${gap}`;
  }
  const missing = missingKits(KIT_REQUIREMENTS[visualType], kits);
  return missing.length > 0 ? `the kit it needs is missing: ${missing.join(", ")}` : null;
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
    const productReason = productPixelRejection(visualType, input.showsProduct, input.kits.productKit);
    if (productReason !== null) {
      reject("rule2_product_pixels", productReason);
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
      reject("rule5_budget", cost.reason);
      continue;
    }
    if (!usdAtMost(cost.totalUsd, input.remainingUsd)) {
      reject("rule5_budget", `costs ${cost.totalUsd} USD, above the remaining ${input.remainingUsd} USD`);
      continue;
    }

    // Rule 6: the persona, character or product kit the type needs must exist, and its source must be buildable.
    const kitReason = kitRejection(visualType, input.kits);
    if (kitReason !== null) {
      reject("rule6_kit", kitReason);
      continue;
    }
    // A chain's closing component must be drawable (chains.ts). Checked after the price, as rule 5 comes first.
    const closing = closingComponentProblem(visualType);
    if (closing !== null) {
      reject("rule6_kit", `no source can be built for it yet: ${closing}`);
      continue;
    }
    const refusal = input.refusals?.[visualType];
    if (refusal !== undefined) {
      reject("rule6_kit", `the shot cannot be built as this type: ${refusal}`);
      continue;
    }

    kept.push({ ...candidate, cost });
  }

  return { kept, rejected };
}
