import { createFileRoute } from "@tanstack/react-router";
import { ContentHub } from "@/components/content-factory/content-hub";
import { contentSearchOf } from "@/components/content-factory/content-hub-model";

/** The Content page without a brand in the URL, so it offers a brand picker. `?session=<id>` opens that session, which an opportunity's brief links to. */
export const Route = createFileRoute("/_app/content-factory")({
  staticData: { pageTitle: "Content" },
  validateSearch: contentSearchOf,
  component: WorkspaceContentRoute,
});

function WorkspaceContentRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ContentHub
      brandId={null}
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: next, replace })}
    />
  );
}
