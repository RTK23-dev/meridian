/**
 * Pure view model for one connection row. It turns the row's status, the server's sentence and the last recorded error or
 * success into one label, a tone, a reason and one action. Connected needs positive evidence: a HEALTHY or CONNECTED status
 * and a readable time of the last successful request. Every other state is named as it is, and an Error always carries its
 * reason. Status words are read the way src/components/ui/status-map.ts reads them, with the case and separators normalised.
 */
import { CONNECTION_MESSAGES } from "../../lib/copy.ts";
import { isOAuthProvider } from "./oauth-providers.ts";

export type ConnectionLabel = "Connected" | "NOT CONNECTED" | "Error" | "Checking";
export type ConnectionTone = "success" | "neutral" | "danger" | "info";
/** `to` is the route that holds the next step, or null when the action runs on the row where it is shown. */
export type ConnectionAction = { label: string; to: string | null };
export type ConnectionState = { label: ConnectionLabel; tone: ConnectionTone; reason: string | null; action: ConnectionAction };

/** One connection row as the server reports it. Every field may be missing, and a missing field is never read as a success. */
export type ConnectionRow = {
  provider?: string | null;
  status?: string | null;
  detail?: string | null;
  lastError?: string | null;
  lastSuccessAt?: string | null;
};

/** Where connecting and reconnecting happen today. The connect steps get their own route in a later wave. */
export const CONNECT_ROUTE = "/integrations";

const ERROR_STATUSES: ReadonlySet<string> = new Set(["FAILED", "FAILURE", "ERROR", "UNHEALTHY"]);
const CHECKING_STATUSES: ReadonlySet<string> = new Set(["CONNECTING", "SYNCING"]);

const NO_REASON = "No reason was recorded.";
const NO_STATE = "No connection state was reported for this provider.";
const NO_SUCCESS = "No successful request is recorded yet.";
const UNREADABLE_SUCCESS = "Last successful request: time not readable.";
const DISCONNECTED = "Disconnected in Meridian. No further requests are sent until someone reconnects.";
const STALE = "The last successful request is stale.";

const TEST: ConnectionAction = { label: "Test connection", to: null };

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function normalizeStatus(status: string | null | undefined): string {
  return (text(status) ?? "").toUpperCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function notConnected(reason: string, action: ConnectionAction): ConnectionState {
  return { label: "NOT CONNECTED", tone: "neutral", reason, action };
}

export function connectionState(row: ConnectionRow | null | undefined): ConnectionState {
  const status = normalizeStatus(row?.status);
  const detail = text(row?.detail);
  const lastSuccessAt = text(row?.lastSuccessAt);
  const provider = (text(row?.provider) ?? "").toLowerCase();

  if (status === "HEALTHY" || status === "CONNECTED") {
    if (lastSuccessAt && Number.isFinite(Date.parse(lastSuccessAt))) {
      return { label: "Connected", tone: "success", reason: null, action: TEST };
    }
    return notConnected(lastSuccessAt ? UNREADABLE_SUCCESS : NO_SUCCESS, TEST);
  }
  if (ERROR_STATUSES.has(status)) {
    return { label: "Error", tone: "danger", reason: text(row?.lastError) ?? detail ?? NO_REASON, action: TEST };
  }
  if (CHECKING_STATUSES.has(status)) {
    return { label: "Checking", tone: "info", reason: detail, action: { label: "Refresh status", to: null } };
  }
  if (status === "DISCONNECTED") return notConnected(detail ?? DISCONNECTED, { label: "Reconnect", to: null });
  if (status === "DEGRADED") return notConnected(detail ?? STALE, TEST);
  if (status === "SUPPORTED") return notConnected(detail ?? NO_SUCCESS, TEST);
  if (status === "NOT_CONFIGURED" || status === "NOT_CONNECTED") {
    return notConnected(detail ?? CONNECTION_MESSAGES.notConnected, isOAuthProvider(provider) ? { label: "Connect", to: CONNECT_ROUTE } : TEST);
  }
  return notConnected(detail ?? NO_STATE, TEST);
}
