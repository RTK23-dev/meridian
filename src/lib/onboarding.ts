export type OnboardingBrand = { id: string; completeness: number; competitors: number; opportunities: number; creatives: number };
export type OnboardingStep = { label: string; done: boolean; to: string; brandId: string };

export function getOnboardingSteps(input: { brands: OnboardingBrand[]; providerConnected: boolean; reviewedCreative: boolean }): OnboardingStep[] {
  const firstBrand = input.brands[0];
  const target = (suffix: string) => firstBrand ? `/brands/${firstBrand.id}/${suffix}` : "/brands/new";
  return [
    { label: "Create a brand", done: input.brands.length > 0, to: "/brands/new", brandId: "" },
    { label: "Complete a brand brain", done: input.brands.some((brand) => brand.completeness >= 1), to: target("brain"), brandId: firstBrand?.id ?? "" },
    { label: "Connect a provider", done: input.providerConnected, to: "/integrations", brandId: "" },
    { label: "Add a competitor", done: input.brands.some((brand) => brand.competitors > 0), to: target("market"), brandId: firstBrand?.id ?? "" },
    { label: "Rank opportunities", done: input.brands.some((brand) => brand.opportunities > 0), to: target("opportunities"), brandId: firstBrand?.id ?? "" },
    { label: "Generate a creative", done: input.brands.some((brand) => brand.creatives > 0), to: target("studio"), brandId: firstBrand?.id ?? "" },
    { label: "Review a creative", done: input.reviewedCreative, to: target("reviews"), brandId: firstBrand?.id ?? "" },
  ];
}
