import { createFileRoute } from "@tanstack/react-router";
import { ContentHub } from "@/components/content-factory/content-hub";
import { contentSearchOf } from "@/components/content-factory/content-hub-model";

/** One brand's Content page. `?section=` opens a section, `?preset=` a starting mode and `?session=` an engine session. */
export const Route = createFileRoute("/_app/brands/$brandId/content")({
  staticData: { pageTitle: "Content" },
  validateSearch: contentSearchOf,
  component: BrandContentRoute,
});

function BrandContentRoute() {
  const { brandId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ContentHub
      brandId={brandId}
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: next, replace })}
    />
  );
}
