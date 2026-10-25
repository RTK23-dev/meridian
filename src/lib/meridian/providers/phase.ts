export const CONNECTION_PHASES = [
  "NOT_CONFIGURED",
  "CONNECTING",
  "CONNECTED",
  "SYNCING",
  "HEALTHY",
  "DEGRADED",
  "FAILED",
  "DISCONNECTED",
] as const;

export type ConnectionPhase = (typeof CONNECTION_PHASES)[number];

/**
 * How long a recorded provider success counts as fresh. Past this window a stored success is DEGRADED, not HEALTHY. The value is one
 * day: the success is recorded only when someone checks or connects the provider, so a shorter window fails closed sooner.
 */
export const PROVIDER_SUCCESS_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a recorded success is stale. No success is not stale: it is simply not recorded, and the phase says so. A success that
 * cannot be read as a time is stale, so an unreadable record never reads as fresh.
 */
export function successIsStale(lastSuccessAt: unknown, now: number = Date.now()): boolean {
  if (!lastSuccessAt) return false;
  const at = lastSuccessAt instanceof Date ? lastSuccessAt.getTime() : Date.parse(String(lastSuccessAt));
  if (!Number.isFinite(at)) return true;
  return now - at > PROVIDER_SUCCESS_FRESH_MS;
}

/**
 * Credentials alone are not a connection.
 * HEALTHY requires a recorded successful provider response that is still fresh.
 */
export function connectionPhase(input: {
  configured: boolean;
  disconnected: boolean;
  probing: boolean;
  syncing: boolean;
  lastOk: boolean | null;
  stale: boolean;
  lastError: string;
}): { phase: ConnectionPhase; detail: string } {
  if (input.disconnected) {
    return { phase: "DISCONNECTED", detail: "Disconnected in Meridian. No further requests are sent until someone reconnects." };
  }
  if (!input.configured) {
    return { phase: "NOT_CONFIGURED", detail: "No credentials are configured. No request was sent." };
  }
  if (input.probing) return { phase: "CONNECTING", detail: "A connection request is in progress." };
  if (input.syncing) return { phase: "SYNCING", detail: "A sync is in progress." };
  // The most recent probe decides. A recorded error means the latest probe failed, even when an earlier probe succeeded.
  if (input.lastError) return { phase: "FAILED", detail: input.lastError };
  if (input.lastOk === true && input.stale) {
    return { phase: "DEGRADED", detail: "The last successful request is stale." };
  }
  if (input.lastOk === true) return { phase: "HEALTHY", detail: "The last provider request succeeded." };
  return {
    phase: "NOT_CONFIGURED",
    detail: "Credentials are present, but no successful provider request has been recorded. This is not connected.",
  };
}
