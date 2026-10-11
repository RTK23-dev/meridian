import type { Sql } from "../learning/store.ts";
import { activeWebhookOrganizations, findStoredWebhookEventIds, storeWebhookEvent } from "./receive-store.ts";
import { verifyWebhook } from "./verify.ts";

export interface WebhookReceiveDeps {
  /** Opens the database. Called after the request is accepted for routing, so a refused request does not reach it. */
  sql: () => Promise<Sql>;
  secret: string;
  nowMs: number;
}

/**
 * Accepts one signed provider event for the single organization its account is connected to.
 *
 * No tenant is guessed. An account with an active connection in exactly one organization is routed there. An account
 * connected in several organizations is refused with 409 and nothing is stored, because the delivery cannot say which
 * workspace it belongs to. The 409 is returned only after the signature checks pass, so an unsigned caller cannot tell
 * how an account is connected. An account with no active connection stays 401.
 */
export async function handleWebhookReceive(request: Request, deps: WebhookReceiveDeps): Promise<Response> {
  const rawBody = await request.text();
  const provider = request.headers.get("x-meridian-provider") ?? "";
  const signature = request.headers.get("x-meridian-signature") ?? "";
  const timestamp = request.headers.get("x-meridian-timestamp") ?? "";
  const eventId = request.headers.get("x-meridian-event") ?? "";
  const account = request.headers.get("x-meridian-account") ?? "";
  const sql = await deps.sql();
  const organizations = account ? await activeWebhookOrganizations(sql, { provider, accountId: account }) : [];
  const organizationId = organizations.length === 1 ? organizations[0] : undefined;
  const seen = eventId && organizationId ? await findStoredWebhookEventIds(sql, { organizationId, provider, eventId }) : [];
  const decision = verifyWebhook({
    secret: deps.secret,
    timestamp,
    signature,
    rawBody,
    eventId,
    nowMs: deps.nowMs,
    seenEventIds: seen,
    accountKnown: organizations.length > 0,
  });
  if (decision.status === "rejected") return new Response(decision.reason, { status: 401 });
  if (organizations.length > 1) {
    console.warn(
      `[webhooks] Refused ${provider} event ${eventId} for account ${account}: the account is connected to more than one organization. No organization was chosen and nothing was stored.`,
    );
    return new Response("This account is connected to more than one workspace, so the event cannot be routed.", { status: 409 });
  }
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
}
