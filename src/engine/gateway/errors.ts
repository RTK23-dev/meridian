// Turns a provider's HTTP answer into a typed EngineError (Bible 17.2 rule 5). The provider's body is untrusted data: only a
// short, single-line excerpt of it enters the message, and it is never acted on.

import { EngineError } from "../contracts/errors.ts";
import type { HttpResponse } from "./types.ts";

const EXCERPT_CHARS = 300;

export function bodyText(response: HttpResponse): string {
  return new TextDecoder().decode(response.body);
}

function excerpt(response: HttpResponse): string {
  const text = bodyText(response).replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}...` : text;
}

/** The error for a non-2xx answer. Rate limits, timeouts and server errors are retryable; nothing else is. */
export function httpError(provider: string, response: HttpResponse, stage?: string): EngineError {
  const status = response.status;
  const detail = excerpt(response);
  const message = `${provider} answered ${status}${detail ? `: ${detail}` : ""}`;
  if (status === 400 || status === 422) return new EngineError("invalid_input", message, { stage });
  if (status === 401 || status === 403) {
    return new EngineError("config", `${provider} refused the credential (${status}); no further request is made`, { stage });
  }
  if (status === 402) return new EngineError("provider", `${provider} has no credit left for this call (402)`, { stage });
  if (status === 404) return new EngineError("not_found", message, { stage });
  if (status === 408 || status === 429 || (status >= 500 && status !== 501)) {
    return new EngineError("provider", message, { stage, retryable: true });
  }
  return new EngineError("provider", message, { stage });
}

/** Parses a JSON body. A body that is not JSON is a provider error, not a crash. */
export function jsonBody(provider: string, response: HttpResponse, stage?: string): unknown {
  try {
    return JSON.parse(bodyText(response));
  } catch {
    throw new EngineError("provider", `${provider} answered ${response.status} with a body that is not JSON`, { stage });
  }
}
