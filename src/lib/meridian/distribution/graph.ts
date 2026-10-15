import { redactSecrets } from "../observability/redact.ts";
import type { TransportResponse } from "../providers/http.ts";
import type { OrganicPublishReceipt, PlatformId, ReceiptCode } from "./types.ts";

/** The Graph API version the organic publishers call. */
export const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/**
 * The Graph API version the trial reel calls use. Meta documents trial_params and the IG Media fields it reads against v25.0, and the
 * examples use v25.0. The rest of the Instagram flow stays on GRAPH_BASE. The version is not verified live (docs/PROVIDERS.md).
 */
export const TRIAL_GRAPH_BASE = "https://graph.facebook.com/v25.0";

/** Graph error codes for rate limits. The request was refused before it was processed. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);

/** Graph error code for an expired, revoked or invalid access token. */
const INVALID_TOKEN_CODE = 190;

export function parseJsonBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** The id a provider returned in its own response, or "" when there is none. Nothing else is accepted as an id. */
export function responseId(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const id = (json as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
}

function graphError(json: unknown): { code: number | null; message: string } {
  if (!json || typeof json !== "object") return { code: null, message: "" };
  const error = (json as { error?: unknown }).error;
  if (!error || typeof error !== "object") return { code: null, message: "" };
  const record = error as { code?: unknown; message?: unknown };
  return {
    code: typeof record.code === "number" ? record.code : null,
    message: typeof record.message === "string" ? record.message : "",
  };
}

/**
 * Maps a refused provider response to a receipt code. A 401 or 403, or an invalid-token error, is an auth failure. A 429 or a
 * rate-limit error code is retryable. A 5xx is retryable only when no upload had started, because after that the provider may
 * have accepted the content. Anything else is a rejection.
 */
export function classifyFailure(input: {
  label: string;
  response: Pick<TransportResponse, "status">;
  json: unknown;
  uploadStarted?: boolean;
}): { code: ReceiptCode; error: string } {
  const { label, json } = input;
  const status = input.response.status;
  const graph = graphError(json);
  const detail = redactSecrets(graph.message).slice(0, 240);
  if (status === 429 || (graph.code !== null && RATE_LIMIT_CODES.has(graph.code))) {
    return { code: "RETRYABLE", error: `${label} is rate limiting this account (HTTP ${status}). Nothing was confirmed. Try again later.` };
  }
  if (status === 401 || status === 403 || graph.code === INVALID_TOKEN_CODE) {
    return {
      code: "AUTH_FAILED",
      error: `${label} refused the saved access token (HTTP ${status}). Save a current token for this account in Accounts. Nothing was published.`,
    };
  }
  if (status >= 500) {
    if (input.uploadStarted === false) {
      return { code: "RETRYABLE", error: `${label} was unavailable (HTTP ${status}) before the upload began. Nothing was sent. Try again later.` };
    }
    return { code: "UNCONFIRMED", error: unconfirmed(label, `HTTP ${status}`) };
  }
  return { code: "REJECTED", error: `${label} refused the request${detail ? `: ${detail}` : ` (HTTP ${status})`}. Nothing was published.` };
}

/** The message for a request that got no answer, or an answer with no id. The provider may have accepted it. */
export function unconfirmed(label: string, reason: string): string {
  return `${label} did not confirm the publish (${reason}). Nothing is reported as published. Check the account before trying again, so the post is not made twice.`;
}

export function failure(platform: PlatformId, code: ReceiptCode, error: string): OrganicPublishReceipt {
  return { externalId: "", platform, status: "failed", error, code };
}
