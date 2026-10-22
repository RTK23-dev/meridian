// The one place in src/engine that touches the network (gateway/boundaries.test.ts enforces it). Everything else gets an
// HttpTransport from the gateway, and tests inject recorded responses instead of this one.
//
// Redirects are refused, not followed (redirect: "error"). A provider's key travels in a header, and a followed redirect would
// send that header to whatever host the 3xx named. A refused redirect is a non-retryable provider error (redirectRefusal).

import { EngineError } from "../contracts/errors.ts";
import type { HttpRequest, HttpTransport } from "./types.ts";

/** The fetch options of one request. A redirect is an error, so fetch never sends a second request to a redirect target. */
export function fetchInitFor(request: HttpRequest): RequestInit {
  const signals: AbortSignal[] = [];
  if (request.signal) signals.push(request.signal);
  if (request.timeoutMs !== undefined) signals.push(AbortSignal.timeout(request.timeoutMs));
  return {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : typeof request.body === "string" ? request.body : new Uint8Array(request.body),
    signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    redirect: "error",
  };
}

/**
 * The error for a request whose answer was a redirect. Node's fetch rejects a 3xx under redirect "error" with a TypeError whose cause
 * is "unexpected redirect", and it never returns the response, so the exact status is not known here. The message names the class of
 * the answer and never the URL or a credential. Any other failure returns null, and the caller rethrows it unchanged, so the
 * classifier (assets/classify.ts) still sees a timeout, an abort or a network reset as it was.
 */
export function redirectRefusal(error: unknown): EngineError | null {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error) || !/redirect/i.test(error.cause.message)) return null;
  return new EngineError(
    "provider",
    "the provider answered with a redirect (3xx); redirects are refused, so the request was not followed and no credential was sent to the redirect target",
    { retryable: false },
  );
}

export const fetchHttpTransport: HttpTransport = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, fetchInitFor(request));
  } catch (error) {
    throw redirectRefusal(error) ?? error;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
};
