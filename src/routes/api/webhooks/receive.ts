import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { handleWebhookReceive } from "@/lib/meridian/webhooks/receive-handler";

export const Route = createFileRoute("/api/webhooks/receive")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleWebhookReceive(request, {
          sql: getSql,
          secret: process.env.WEBHOOK_SECRET ?? "",
          nowMs: Date.now(),
        }),
    },
  },
});
