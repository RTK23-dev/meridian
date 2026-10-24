import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Results is a section of the Content Factory page. An old Learning link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/learning")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.learning, replace: true });
  },
});
