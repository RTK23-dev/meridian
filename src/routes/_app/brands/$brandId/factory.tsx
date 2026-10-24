import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// The factory is the Ads section of the Content Factory page, which only admins see. An old Factory link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/factory")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.factory, replace: true });
  },
});
