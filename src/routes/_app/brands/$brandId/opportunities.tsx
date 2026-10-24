import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Ideas is a section of the Content Factory page. An old Opportunities link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/opportunities")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.opportunities, replace: true });
  },
});
