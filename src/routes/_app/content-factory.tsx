import { createFileRoute } from "@tanstack/react-router";
import { ContentFactoryScreen } from "@/components/content-factory/screen";

/** `?session=<id>` opens that session on the screen (an opportunity's brief links to it). Any other value is ignored. */
export const Route = createFileRoute("/_app/content-factory")({
  staticData: { pageTitle: "Content Factory" },
  validateSearch: (search: Record<string, unknown>): { session?: string } => {
    const session = typeof search.session === "string" ? search.session : "";
    return session !== "" && session.length <= 80 ? { session } : {};
  },
  component: ContentFactoryRoute,
});

function ContentFactoryRoute() {
  const { session } = Route.useSearch();
  return <ContentFactoryScreen initialSessionId={session ?? null} />;
}
