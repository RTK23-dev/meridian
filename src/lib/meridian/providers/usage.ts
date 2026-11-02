// Records what a real provider request told us about a connection. A test connection already records its result (connect.ts). Performance
// sync and paused publishing also make real requests, so they record here too:
//   - the provider accepted the operation's request and its result was used: the connection's last success is refreshed, and any
//     earlier error is cleared, so the status reads HEALTHY again without a manual test;
//   - the provider refused a request (HTTP 401 or 403): the connection is FAILED, with the reason and the status, until someone tests it;
//   - any other failure (a bad request, a rate limit, a server error, a timeout) says nothing about the credential, so nothing changes.
// A refusal wins over a success in the same operation. The app fails closed: a key that was refused once is not shown HEALTHY.
// Disconnected connections are never written, and a missing connection row is not created here.
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportResponse } from "./http.ts";

const LABEL: Record<string, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google: "Google Ads",
  ad_library: "Meta Ad Library",
};

/** HTTP statuses that mean the provider refused the credential or its permissions. */
export function isRefusalStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** Meta's Graph error code for an invalid or expired access token. The Meta clients in this repo read the same code. */
const META_INVALID_TOKEN_CODE = 190;

/** The Graph error code in a JSON body, or null when the body is not JSON or has no numeric code. */
function metaErrorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } } | null;
    const code = parsed?.error?.code;
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Whether one response refuses the credential. HTTP 401 or 403 does, from any provider. Meta also sends an invalid or expired token as
 * HTTP 400 with error code 190, so that code counts as a refusal whatever the status. Other provider error bodies are not read here:
 * a body code that is not mapped is not treated as a refusal.
 */
export function isRefusal(provider: string, response: TransportResponse): boolean {
  if (isRefusalStatus(response.status)) return true;
  return provider === "meta" && metaErrorCode(response.body) === META_INVALID_TOKEN_CODE;
}

/**
 * Wraps a transport so the caller can ask, after its operation, whether the provider refused any request. Each request still goes
 * through the inner transport unchanged, and its response is returned as it was.
 */
export function observeProviderUse(inner: Transport, provider: string): { transport: Transport; refusedStatus: () => number | null } {
  let refused: number | null = null;
  const transport: Transport = async (request) => {
    const response: TransportResponse = await inner(request);
    if (refused === null && isRefusal(provider, response)) refused = response.status;
    return response;
  };
  return { transport, refusedStatus: () => refused };
}

export type ProviderUse = {
  organizationId: string;
  provider: string;
  /** The status of the first refused request, or null when no request was refused. */
  refusedStatus: number | null;
  /** True when the provider's result was used: a publish stage was confirmed, or a sync read the provider's rows. */
  succeeded: boolean;
};

/** True when a publish confirmed at least one object: a stage the provider stored, with the id it returned. */
export function anyStageConfirmed(stages: readonly { status: string; externalId: string | null }[]): boolean {
  return stages.some((stage) => stage.status === "stored" && Boolean(stage.externalId));
}

export type ProviderUseRecord = "refused" | "succeeded" | "unchanged";

/**
 * Turns a provider's performance schedules on or off for one workspace. Only while the connection is connected: a disconnected one keeps
 * the schedules it has, as the disconnect path leaves them. The schedules follow the same rule as connect.ts: a refused connection stops
 * its scheduled sync, so a refused token is not called again on every cadence.
 */
async function setPerformanceSchedules(sql: Sql, organizationId: string, provider: string, enabled: boolean): Promise<void> {
  await sql`
    update job_schedules set enabled = ${enabled}
    where organization_id = ${organizationId}
      and job_type = 'performance.sync'
      and id like ${`perf:${organizationId}:%:${provider}`}
      and exists (
        select 1 from provider_connections
        where organization_id = ${organizationId} and provider = ${provider} and disconnected_at is null
      )
  `;
}

/** Writes one operation's outcome to its connection. Returns what was written, so callers and tests can see the decision. */
export async function recordProviderUse(sql: Sql, use: ProviderUse): Promise<ProviderUseRecord> {
  if (use.refusedStatus !== null) {
    const label = LABEL[use.provider] ?? use.provider;
    const detail = `${label} refused the request (HTTP ${use.refusedStatus}). Test the connection to check the saved credential.`;
    await sql`
      update provider_connections set status = 'FAILED', last_error = ${detail}, updated_at = now()
      where organization_id = ${use.organizationId} and provider = ${use.provider} and disconnected_at is null
    `;
    await setPerformanceSchedules(sql, use.organizationId, use.provider, false);
    return "refused";
  }
  if (use.succeeded) {
    await sql`
      update provider_connections
      set status = 'HEALTHY', last_error = '', last_success_at = now(), updated_at = now()
      where organization_id = ${use.organizationId} and provider = ${use.provider} and disconnected_at is null
    `;
    await setPerformanceSchedules(sql, use.organizationId, use.provider, true);
    return "succeeded";
  }
  return "unchanged";
}
