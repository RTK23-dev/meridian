import { createFileRoute } from "@tanstack/react-router";
import { DocsPage } from "@/components/public/public-pages";

/** The public docs page: the concepts, how a deployment runs, and the repository's reference docs. */
export const Route = createFileRoute("/docs")({
  head: () => ({ meta: [{ title: "Docs · Meridian" }] }),
  component: DocsPage,
});
