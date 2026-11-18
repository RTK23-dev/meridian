import { createFileRoute } from "@tanstack/react-router";
import { CreatePage } from "@/components/create/create-page";
import { createSearchOf } from "@/components/create/create-model";

/**
 * The front door for making something: free with Claude Code, with Meridian (the Content chat, planned for you or step by step), or a batch.
 * The older screens remain reachable by their links. `?draft=<id>` reopens a draft, with its scripts; `?way=` opens on one way to make it.
 */
export const Route = createFileRoute("/_app/create")({
  staticData: { pageTitle: "Create" },
  validateSearch: createSearchOf,
  component: CreateRoute,
});

function CreateRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CreatePage
      draftId={search.draft ?? null}
      onDraft={(draft) => void navigate({ search: draft ? { draft } : {}, replace: true })}
      way={search.way ?? null}
      // A way named in the address is applied and remembered once, then dropped, so the person's next choice is not overridden on reload.
      onWayLink={() => void navigate({ search: search.draft ? { draft: search.draft } : {}, replace: true })}
    />
  );
}
