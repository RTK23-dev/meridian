/**
 * Setup steps for a new workspace. A step is done only when a stored record shows it. A value that could not be loaded is
 * unknown, which is not the same as not done: the checklist says so and still links to the fix.
 */
export type OnboardingBrand = {
  id: string;
  completeness: number;
  /** Null when the brand's counts have not loaded. */
  competitors: number | null;
  opportunities: number | null;
  creatives: number | null;
};
export type StepState = "done" | "todo" | "unknown";
export type OnboardingStep = { label: string; state: StepState; done: boolean; to: string; brandId: string };

/** The stored review list holds at most this many rows (listReviews in publishing/actions.ts). */
export const REVIEW_LIST_LIMIT = 40;

/** Done wins. Otherwise the step is to do when everything it depends on is known, and unknown when something is missing. */
function stateOf(done: boolean, known: boolean): StepState {
  if (done) return "done";
  return known ? "todo" : "unknown";
}

export function getOnboardingSteps(input: {
  brands: OnboardingBrand[];
  /** Null when the provider connections have not loaded. */
  providerConnected: boolean | null;
  /** Null when the review lists cannot settle the question yet. See reviewedCreativeState. */
  reviewedCreative: boolean | null;
}): OnboardingStep[] {
  const firstBrand = input.brands[0];
  const target = (suffix: string) => firstBrand ? `/brands/${firstBrand.id}/${suffix}` : "/brands/new";
  const brandId = firstBrand?.id ?? "";
  // A count is known for every brand, or the answer cannot be given. An empty workspace knows that it has no brands.
  const countKnown = (pick: (brand: OnboardingBrand) => number | null) => input.brands.every((brand) => pick(brand) !== null);
  const step = (label: string, done: boolean, known: boolean, to: string, stepBrandId: string): OnboardingStep => {
    const state = stateOf(done, known);
    return { label, state, done: state === "done", to, brandId: stepBrandId };
  };
  return [
    step("Create a brand", input.brands.length > 0, true, "/brands/new", ""),
    step("Complete a brand brain", input.brands.some((brand) => brand.completeness >= 1), true, target("brain"), brandId),
    step("Connect a provider", input.providerConnected === true, input.providerConnected !== null, "/integrations", ""),
    step("Add a competitor", input.brands.some((brand) => (brand.competitors ?? 0) > 0), countKnown((brand) => brand.competitors), target("market"), brandId),
    step("Rank opportunities", input.brands.some((brand) => (brand.opportunities ?? 0) > 0), countKnown((brand) => brand.opportunities), target("opportunities"), brandId),
    step("Generate a creative", input.brands.some((brand) => (brand.creatives ?? 0) > 0), countKnown((brand) => brand.creatives), target("studio"), brandId),
    step("Review a creative", input.reviewedCreative === true, input.reviewedCreative !== null, target("reviews"), brandId),
  ];
}

/** Counts for the checklist heading: how many steps have a record, how many are in total, and how many could not be checked. */
export function onboardingSummary(steps: readonly OnboardingStep[]): { done: number; total: number; unknown: number } {
  return {
    done: steps.filter((step) => step.state === "done").length,
    total: steps.length,
    unknown: steps.filter((step) => step.state === "unknown").length,
  };
}

/**
 * Whether a creative has been reviewed, from the stored review lists of every brand. One decided review is enough. Otherwise
 * the answer is unknown while a list has not loaded, and also when a full list holds no decided review, because older rows
 * may hold one.
 */
export function reviewedCreativeState(lists: readonly { loaded: boolean; decided: number; listed: number }[]): boolean | null {
  if (lists.some((list) => list.decided > 0)) return true;
  if (lists.some((list) => !list.loaded)) return null;
  if (lists.some((list) => list.listed >= REVIEW_LIST_LIMIT)) return null;
  return false;
}
