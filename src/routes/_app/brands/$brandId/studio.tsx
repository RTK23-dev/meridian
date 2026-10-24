import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Studio is the Create section of the Content Factory page. An old Studio link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/studio")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.studio, replace: true });
  },
});
