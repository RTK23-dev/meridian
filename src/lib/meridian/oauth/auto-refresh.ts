// Renews a stored OAuth access token before it lapses, so a performance sync or a publish does not start with a token its provider has
// already expired. Providers expire access tokens at different rates (Google's about an hour, TikTok's about a day), so renewal runs on
// use, not on a timer: a request that needs the token renews it first when it is within RENEW_AHEAD_MS of its stated expiry.
//
// The renewal is the routine the Connections screen's Refresh button calls (refreshOauthToken), so both paths behave the same. It is a
// compare-and-set on the token it read: if another request renewed the token first, that token stays and this one writes nothing.
// A renewal the provider refuses (its refresh token revoked, or Meta's invalid-token code) marks the connection FAILED, the same as any
// refusal (providers/usage.ts). Any other failure changes nothing, and the token keeps its expiry, so the request reports it as before.
import type { Sql } from "../learning/store.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import type { Transport } from "../providers/http.ts";
import { observeProviderUse, recordProviderUse } from "../providers/usage.ts";
import { openSecret, refreshOauthToken, sealSecret } from "./flow.server.ts";

/** Renew a token this long before its stated expiry, so a request never starts with a token about to lapse. */
export const RENEW_AHEAD_MS = 5 * 60 * 1000;

export type RenewOutcome = "not_due" | "no_refresh_token" | "renewed" | "superseded" | "refused" | "failed";

/**
 * Whether a stored token needs renewing now. A token with no stated expiry is not renewed: the provider said nothing to act on. An
 * expiry that does not read as a time is due, so an unreadable expiry fails toward renewal, and the renewal then says what happened.
 */
export function renewalDue(expiresAt: unknown, now: number): boolean {
  if (!expiresAt) return false;
  const at = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
  if (!Number.isFinite(at)) return true;
  return at - now <= RENEW_AHEAD_MS;
}

/**
 * Renews the workspace's stored token for one provider when it is due. Returns what happened, so the caller can read the new token
 * from the database, or report the reason it could not. Renewal is skipped in the testing runtime, which makes no provider request.
 */
export async function renewStoredToken(
  sql: Sql,
  input: { organizationId: string; provider: string; encryptionKey: string; env: NodeJS.ProcessEnv; transport: Transport; now?: number },
): Promise<RenewOutcome> {
  if (isTestingRuntimeNow()) return "not_due";
  const now = input.now ?? Date.now();
  const rows = await sql<{ sealed_token: string; sealed_refresh: string; expires_at: unknown }>`
    select sealed_token, sealed_refresh, expires_at from provider_secrets
    where organization_id = ${input.organizationId} and provider = ${input.provider} limit 1
  `;
  const row = rows[0];
  if (!row || !renewalDue(row.expires_at, now)) return "not_due";
  if (!row.sealed_refresh.trim()) return "no_refresh_token";
  const refreshToken = openSecret(row.sealed_refresh, input.encryptionKey);
  if (typeof refreshToken !== "string") return "failed";

  const observed = observeProviderUse(input.transport, input.provider);
  const refreshed = await refreshOauthToken(input.provider as "meta" | "tiktok" | "google", { refreshToken, env: input.env }, observed.transport);
  if ("error" in refreshed) {
    const refusedStatus = observed.refusedStatus();
    if (refusedStatus !== null) {
      await recordProviderUse(sql, { organizationId: input.organizationId, provider: input.provider, refusedStatus, succeeded: false });
      return "refused";
    }
    return "failed";
  }

  const accessSealed = sealSecret(refreshed.accessToken, input.encryptionKey);
  const refreshSealed = sealSecret(refreshed.refreshToken, input.encryptionKey);
  if (typeof accessSealed !== "string" || typeof refreshSealed !== "string") return "failed";
  const expiresAt = refreshed.expiresIn === null ? null : new Date(now + refreshed.expiresIn * 1000).toISOString();
  const written = await sql<{ id: string }>`
    update provider_secrets
    set sealed_token = ${accessSealed}, sealed_refresh = ${refreshSealed}, expires_at = ${expiresAt}, updated_at = now()
    where organization_id = ${input.organizationId} and provider = ${input.provider} and sealed_token = ${row.sealed_token}
    returning id
  `;
  return written.length > 0 ? "renewed" : "superseded";
}
