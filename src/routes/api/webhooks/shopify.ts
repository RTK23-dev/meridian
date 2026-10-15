import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { resolveCredential } from "@/lib/meridian/credentials/resolve";
import { handleShopifyWebhook } from "@/lib/meridian/shopify/handler";

/** Shopify's orders/create deliveries. Each shop is routed by its domain, and verified with the workspace's Shopify secret. */
export const Route = createFileRoute("/api/webhooks/shopify")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleShopifyWebhook(request, {
          sql: getSql,
          resolveSecret: async (organizationId) => resolveCredential(await getSql(), organizationId, "shopify"),
        }),
    },
  },
});
