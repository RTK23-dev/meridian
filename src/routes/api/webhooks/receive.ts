import { webhookSecret } from "../../../lib/meridian/credentials/secret-settings.ts";
import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { handleWebhookReceive } from "@/lib/meridian/webhooks/receive-handler";

export const Route = createFileRoute("/api/webhooks/receive")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleWebhookReceive(request, {
          sql: getSql,
          secret: webhookSecret() ?? "",
          nowMs: Date.now(),
        }),
    },
  },
});
