import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { verifyWebhook } from "@/lib/meridian/webhooks/verify";
import { storeWebhookEvent } from "@/lib/meridian/webhooks/receive-store";

export const Route = createFileRoute("/api/webhooks/receive")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const provider = request.headers.get("x-meridian-provider") ?? "";
        const signature = request.headers.get("x-meridian-signature") ?? "";
        const timestamp = request.headers.get("x-meridian-timestamp") ?? "";
        const eventId = request.headers.get("x-meridian-event") ?? "";
        const account = request.headers.get("x-meridian-account") ?? "";
        const sql = await getSql();
        const known = account
          ? await sql<{ organization_id: string }>`
              select organization_id from provider_connections where provider = ${provider} and account_id = ${account} and disconnected_at is null limit 1
            `
          : [];
        const seen = eventId
          ? await sql<{ event_id: string }>`select event_id from webhook_events where provider = ${provider} and event_id = ${eventId} limit 1`
          : [];
        const decision = verifyWebhook({
          secret: process.env.WEBHOOK_SECRET ?? "",
          timestamp,
          signature,
          rawBody,
          eventId,
          nowMs: Date.now(),
          seenEventIds: seen.map((row) => row.event_id),
          accountKnown: known.length > 0,
        });
        if (decision.status === "rejected") return new Response(decision.reason, { status: 401 });
        const organizationId = known[0]?.organization_id;
        if (!organizationId) return new Response("Unknown account.", { status: 401 });
        const stored = await storeWebhookEvent(sql, { organizationId, provider, eventId: decision.eventId });
        if (!stored) return new Response("This event id was already stored.", { status: 200 });
        await sql`
          insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
          values (
            ${crypto.randomUUID()}, ${organizationId}, null, 'webhook.received',
            ${`webhook:${provider}:${decision.eventId}`}, 'queued', ${JSON.stringify({ eventId: decision.eventId, provider })}
          )
          on conflict (organization_id, idempotency_key) do nothing
        `;
        return new Response("queued", { status: 202 });
      },
    },
  },
});
