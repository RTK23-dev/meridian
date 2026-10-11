import type { Sql } from "../learning/store.ts";
import { activeWebhookOrganizations, findStoredWebhookEventIds, storeWebhookEvent } from "./receive-store.ts";
import { verifyWebhook } from "./verify.ts";

export interface WebhookReceiveDeps {
  /** Opens the database. Called only after the body is read and within the cap, so a refused request does not reach it. */
  sql: () => Promise<Sql>;
  secret: string;
  nowMs: number;
}

/**
 * The largest webhook body the receiver reads: 256 KB. Provider events are small JSON objects, so the cap is generous.
 * It is enforced before buffering. A declared Content-Length above it is refused without reading the body, and a body
 * that grows past it while streaming is cut off, so memory stays bounded even without a Content-Length. The edge rate
 * limit in front of this route is separate and is not implemented here.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

/** Providers send JSON; a charset parameter is accepted. Any other media type is refused with 415. */
function isJsonContentType(value: string | null): boolean {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

function refusal(message: string, status: number): Response {
  return new Response(message, { status });
}

/** Reads the body up to the cap. The result is the text, or the refusal to return instead. */
async function readBoundedBody(request: Request): Promise<{ text: string } | { refusal: Response }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { refusal: refusal("Content-Length must be a number.", 400) };
    if (Number(declared) > WEBHOOK_BODY_LIMIT_BYTES) return { refusal: refusal("The webhook payload is too large.", 413) };
  }
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WEBHOOK_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return { refusal: refusal("The webhook payload is too large.", 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

/**
 * Accepts one signed provider event for the single organization its account is connected to.
 *
 * No tenant is guessed. An account with an active connection in exactly one organization is routed there. An account
 * connected in several organizations is refused with 409 and nothing is stored, because the delivery cannot say which
 * workspace it belongs to. The 409 is returned only after the signature checks pass, so an unsigned caller cannot tell
 * how an account is connected. An account with no active connection stays 401.
 *
 * The media type is checked first (415), then the body is read within the cap (413), then the signature is checked over
 * those raw bytes before the JSON is parsed.
 */
export async function handleWebhookReceive(request: Request, deps: WebhookReceiveDeps): Promise<Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return refusal("Webhook payloads must be application/json.", 415);
  }
  const body = await readBoundedBody(request);
  if ("refusal" in body) return body.refusal;
  const rawBody = body.text;
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
