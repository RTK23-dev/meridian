import { createFileRoute } from "@tanstack/react-router";
import { CreatePage } from "@/components/create/create-page";
import { createSearchOf } from "@/components/create/create-model";

/**
 * One place to make something: the Content chat, Orchestrator and Studio, merged. The older screens remain reachable by their links.
 * `?draft=<id>` reopens a draft, with its scripts.
 */
export const Route = createFileRoute("/_app/create")({
  staticData: { pageTitle: "Create" },
  validateSearch: createSearchOf,
  component: CreateRoute,
});

function CreateRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CreatePage draftId={search.draft ?? null} onDraft={(draft) => void navigate({ search: draft ? { draft } : {}, replace: true })} />;
}
