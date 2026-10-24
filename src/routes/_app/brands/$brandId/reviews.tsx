import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Review is a section of the Content page. An old Reviews link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/reviews")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.reviews, replace: true });
  },
});
