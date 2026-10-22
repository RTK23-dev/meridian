import type { Sql } from "../learning/store.ts";
import { activeWebhookOrganizations, recordWebhookDelivery } from "./receive-store.ts";
import { clientKey, createRateLimit, RATE_LIMIT_MESSAGE } from "../security/limits.ts";
import { verifyDeliverySignature } from "./verify.ts";

/**
 * Deliveries one client may send in a minute. The client is the request's address when MERIDIAN_TRUST_PROXY_HEADERS is set. Without it,
 * every delivery shares one bucket, so a flood of unsigned requests can use up the bucket for real deliveries too. Those are retried by
 * the sender. The limit is high because a sender may burst after an outage.
 */
export const webhookLimit = createRateLimit(300, 60_000);

export interface WebhookReceiveDeps {
  /**
   * Opens the database. Called only after the body is read (within the cap and the deadline) and after the signature and
   * timestamp pass, so a refused delivery does not reach it.
   */
  sql: () => Promise<Sql>;
  secret: string;
  nowMs: number;
  /** How long the whole body may take to arrive. Defaults to WEBHOOK_BODY_DEADLINE_MS. Tests shorten it. */
  bodyDeadlineMs?: number;
  /** The per-client limit. Defaults to webhookLimit. Tests pass their own. */
  limiter?: { allow: (key: string, now: number) => boolean };
}

/**
 * The largest webhook body the receiver reads: 256 KB. Provider events are small JSON objects, so the cap is generous.
 * It is enforced before buffering. A declared Content-Length above it is refused without reading the body, and a body
 * that grows past it while streaming is cut off, so memory stays bounded even without a Content-Length. The edge rate
 * limit in front of this route is separate and is not implemented here.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * The total time the receiver waits for the body, from its first read to its last. A body still arriving when this
 * passes is refused with 408, so a stalled sender cannot hold the request open. Providers send each event at once.
 */
export const WEBHOOK_BODY_DEADLINE_MS = 10 * 1000;

const DEADLINE_PASSED = Symbol("deadline-passed");

/** Providers send JSON; a charset parameter is accepted. Any other media type is refused with 415. */
function isJsonContentType(value: string | null): boolean {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

function refusal(message: string, status: number): Response {
  return new Response(message, { status });
}

/**
 * Reads the body up to the cap and within the deadline. The result is the text, or the refusal to return instead.
 * The deadline is one timer for the whole read, not a timeout per chunk, so a trickle of bytes cannot extend it.
 */
export async function readBoundedBody(request: Request, deadlineMs: number): Promise<{ text: string } | { refusal: Response }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { refusal: refusal("Content-Length must be a number.", 400) };
    if (Number(declared) > WEBHOOK_BODY_LIMIT_BYTES) return { refusal: refusal("The webhook payload is too large.", 413) };
  }
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), deadlineMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === DEADLINE_PASSED) {
        // Not awaited: a stalled source may never settle its cancel, and the 408 must not wait on it.
        reader.cancel().catch(() => {});
        return { refusal: refusal("The webhook body did not arrive in time.", 408) };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > WEBHOOK_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return { refusal: refusal("The webhook payload is too large.", 413) };
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
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
 * The order is fixed. The rate limit is checked first (429), before anything is read. The media type is checked next (415). The body is
 * read within the cap and the deadline (413, 408). The v2 signature over the routing headers and the raw bytes, the timestamp and the
 * JSON are checked (401) before any database access. Only then is the account resolved. The event and its job are recorded in one
 * transaction: 202 "recorded" for a new event, and 200 "already received" for a repeat, whose job is still ensured.
 */
export async function handleWebhookReceive(request: Request, deps: WebhookReceiveDeps): Promise<Response> {
  if (!(deps.limiter ?? webhookLimit).allow(clientKey(request), deps.nowMs)) {
    return refusal(RATE_LIMIT_MESSAGE, 429);
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return refusal("Webhook payloads must be application/json.", 415);
  }
  const body = await readBoundedBody(request, deps.bodyDeadlineMs ?? WEBHOOK_BODY_DEADLINE_MS);
  if ("refusal" in body) return body.refusal;
  const provider = request.headers.get("x-meridian-provider") ?? "";
  const signature = request.headers.get("x-meridian-signature") ?? "";
  const timestamp = request.headers.get("x-meridian-timestamp") ?? "";
  const eventId = request.headers.get("x-meridian-event") ?? "";
  const account = request.headers.get("x-meridian-account") ?? "";
  const delivery = verifyDeliverySignature({
    secret: deps.secret,
    provider,
    account,
    timestamp,
    signature,
    rawBody: body.text,
    eventId,
    nowMs: deps.nowMs,
  });
  if (delivery.status === "rejected") return refusal(delivery.reason, 401);

  const sql = await deps.sql();
  const organizations = account ? await activeWebhookOrganizations(sql, { provider, accountId: account }) : [];
  if (organizations.length > 1) {
    console.warn(
      `[webhooks] Refused ${provider} event ${eventId} for account ${account}: the account is connected to more than one organization. No organization was chosen and nothing was stored.`,
    );
    return refusal("This account is connected to more than one workspace, so the event cannot be routed.", 409);
  }
  const organizationId = organizations[0];
  if (!organizationId) return refusal("The account on the webhook is not connected to a workspace.", 401);
  // The event and its job commit together. A repeat of a stored event stores nothing new and still ensures its job. It is
  // answered 200, not refused, because the delivery is already held.
  const stored = await recordWebhookDelivery(sql, { organizationId, provider, eventId: delivery.eventId });
  if (!stored) return new Response("already received", { status: 200 });
  return new Response("recorded", { status: 202 });
}
