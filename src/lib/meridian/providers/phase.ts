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
  if (input.lastOk === true && input.stale) {
    return { phase: "DEGRADED", detail: "The last successful request is stale." };
  }
  if (input.lastOk === true) return { phase: "HEALTHY", detail: "The last provider request succeeded." };
  if (input.lastError) return { phase: "FAILED", detail: input.lastError };
  return {
    phase: "NOT_CONFIGURED",
    detail: "Credentials are present, but no successful provider request has been recorded. This is not connected.",
  };
}
