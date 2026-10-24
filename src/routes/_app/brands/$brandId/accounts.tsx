import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_CONTENT_ROUTES } from "@/components/content-factory/content-hub-model";

// Connected accounts are the Publish section of the Content Factory page. An old accounts link opens that section.
export const Route = createFileRoute("/_app/brands/$brandId/accounts")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/brands/$brandId/content", params, search: LEGACY_CONTENT_ROUTES.accounts, replace: true });
  },
});
