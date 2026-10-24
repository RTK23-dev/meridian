import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Library is a section of the Content page. An old Library link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/library")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.library, replace: true });
  },
});
