import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useWorkspace } from "@/components/workspace";
import { ContentHub } from "@/components/content-factory/content-hub";
import { contentSearchOf } from "@/components/content-factory/content-hub-model";

/**
 * The Content page without a brand in the URL. With one brand it is that brand's Content page, so it redirects there (keeping the section,
 * mode and session in the address). With several it offers a brand picker; with none, each section says to create a brand first.
 * `?session=<id>` opens that session, which an opportunity's brief links to.
 */
export const Route = createFileRoute("/_app/content-factory")({
  staticData: { pageTitle: "Content" },
  validateSearch: contentSearchOf,
  component: WorkspaceContentRoute,
});

function WorkspaceContentRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: workspace } = useWorkspace();
  const brands = workspace?.brands ?? [];
  if (workspace?.active && brands.length === 1) {
    return <Navigate to="/brands/$brandId/content" params={{ brandId: brands[0]!.id }} search={search} replace />;
  }
  return (
    <ContentHub
      brandId={null}
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: next, replace })}
    />
  );
}
