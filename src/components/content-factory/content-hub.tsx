import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, EmptyState, PageHeader, ScreenSkeleton, SelectInput, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { ContentFactoryScreen } from "./screen";
import {
  CONTENT_SECTION_LABELS,
  defaultPreset,
  presetsFor,
  searchForSection,
  sectionOf,
  sectionsFor,
  type ContentSearch,
  type ContentSection,
} from "./content-hub-model";

// Each section loads the first time it is opened, so the page does not load every screen up front.
const Studio = lazy(() => import("./sections/studio").then((module) => ({ default: module.Studio })));
const Opportunities = lazy(() => import("./sections/opportunities").then((module) => ({ default: module.Opportunities })));
const Reviews = lazy(() => import("./sections/reviews").then((module) => ({ default: module.Reviews })));
const Library = lazy(() => import("./sections/library").then((module) => ({ default: module.Library })));
const BrandAccounts = lazy(() => import("./sections/accounts").then((module) => ({ default: module.BrandAccounts })));
const Learning = lazy(() => import("./sections/learning").then((module) => ({ default: module.Learning })));
const FactoryPage = lazy(() => import("./sections/factory").then((module) => ({ default: module.FactoryPage })));

type Props = {
  /** The brand in the URL. Null on the workspace-level page, which then offers a brand picker. */
  brandId: string | null;
  /** The section, starting mode and engine session from the URL. The URL is the source, so a link, Back and a refresh agree. */
  search: ContentSearch;
  /** Writes new search values to the URL. `replace` swaps the current history entry instead of adding one. */
  onSearchChange: (next: ContentSearch, replace: boolean) => void;
};

// The brand sections. Each is the screen that already existed, and keeps its own role checks.
const BRAND_VIEWS: Record<Exclude<ContentSection, "create">, (brandId: string) => ReactNode> = {
  ideas: (brandId) => <Opportunities brandId={brandId} />,
  review: (brandId) => <Reviews brandId={brandId} />,
  library: (brandId) => <Library brandId={brandId} />,
  publish: (brandId) => <BrandAccounts brandId={brandId} />,
  results: (brandId) => <Learning brandId={brandId} />,
  ads: (brandId) => <FactoryPage brandId={brandId} />,
};

/** The one content page: ideas, create, review, library, publish, results and ads for a brand, in one place. */
export function ContentHub({ brandId: routeBrandId, search, onSearchChange }: Props) {
  const { data: workspace } = useWorkspace();
  const role = workspace?.active?.role ?? "viewer";
  const isAdmin = hasRole(role, "admin");
  const brands = workspace?.brands ?? [];
  const [pickedBrandId, setPickedBrandId] = useState<string | null>(null);

  if (!workspace?.active) return null;

  const pickBrand = routeBrandId === null && brands.length > 1;
  const activeBrandId =
    routeBrandId ?? (pickedBrandId !== null && brands.some((brand) => brand.id === pickedBrandId) ? pickedBrandId : (brands[0]?.id ?? null));
  // A section the person may not use is not shown, even when the link names it. Create is the fallback.
  const sections = sectionsFor(isAdmin);
  const current: ContentSection = search.section !== undefined && sections.includes(search.section) ? search.section : "create";
  const presets = presetsFor(isAdmin);
  const preset = presets.find((item) => item.id === search.preset) ?? defaultPreset(isAdmin);

  const brandPicker = pickBrand ? (
    <div className="w-56">
      <label htmlFor="cc-brand" className="sr-only">Brand</label>
      <SelectInput id="cc-brand" value={activeBrandId ?? ""} onChange={(event) => setPickedBrandId(event.target.value)}>
        {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
      </SelectInput>
    </div>
  ) : null;

  // Without a brand, a brand section has nothing to show. The empty state says what to do next.
  const noBrand = brands.length === 0 ? (
    <EmptyState
      title="Create a brand first"
      reason="Each section works on one brand. Create a brand, then come back here."
      action={<Button asChild variant="secondary"><Link to="/brands/new">Create a brand</Link></Button>}
    />
  ) : (
    <EmptyState title="Choose a brand first" reason="Pick a brand above. Each section works on that brand." />
  );

  const create = (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="What to make" className="grid gap-3 md:grid-cols-3">
        {presets.map((item) => {
          const selected = item.id === preset.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSearchChange({ section: "create", preset: item.id }, true)}
              className={`rounded-md border bg-surface-2 p-3 text-left transition-colors ${selected ? "border-accent" : "border-border"}`}
            >
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="mt-1 block text-sm text-muted">{item.description}</span>
            </button>
          );
        })}
      </div>
      {preset.mode === "engine" ? (
        <ContentFactoryScreen embedded initialSessionId={search.session ?? null} />
      ) : activeBrandId ? (
        <Studio brandId={activeBrandId} />
      ) : noBrand}
    </div>
  );

  let body: ReactNode;
  if (current === "create") body = create;
  else if (activeBrandId) body = BRAND_VIEWS[current](activeBrandId);
  else body = noBrand;

  const description = `Make, review, publish and learn from your videos, images and ads in one place.${pickBrand ? " Each section works on the brand you pick." : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Content Factory" description={description} actions={brandPicker} />
      <Tabs value={current} onValueChange={(value) => onSearchChange(searchForSection(search, sectionOf(value)), false)} className="space-y-6">
        <TabsList>
          {sections.map((item) => (
            <TabsTrigger key={item} value={item}>{CONTENT_SECTION_LABELS[item]}</TabsTrigger>
          ))}
        </TabsList>
        {/* Only the open section is mounted, so its data loads when it is opened. */}
        <div role="tabpanel" className="min-w-0">
          <Suspense fallback={<ScreenSkeleton label="Loading section" shape="cards" />}>{body}</Suspense>
        </div>
      </Tabs>
    </div>
  );
}
