import { createFileRoute } from "@tanstack/react-router";
import { CookbookLibraryScreen } from "@/components/cookbooks/library-screen";

export const Route = createFileRoute("/_app/brands/$brandId/cookbooks")({ staticData: { pageTitle: "Cookbooks" }, component: CookbooksRoute });

function CookbooksRoute() {
  const { brandId } = Route.useParams();
  return <CookbookLibraryScreen brandId={brandId} />;
}
