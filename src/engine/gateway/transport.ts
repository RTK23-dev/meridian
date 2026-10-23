// The one place in src/engine that touches the network (gateway/boundaries.test.ts enforces it). Everything else gets an
// HttpTransport from the gateway, and tests inject recorded responses instead of this one.
//
// Redirects are refused, not followed (redirect: "error"). A provider's key travels in a header, and a followed redirect would
// send that header to whatever host the 3xx named. A refused redirect is a non-retryable provider error (redirectRefusal).
// A download with pinnedAddresses goes over node:https, connects only to the addresses its host was checked to resolve to, and
// refuses a redirect the same way (pinnedHttpRequest).

import { request as httpsRequest, type RequestOptions } from "node:https";
import { EngineError } from "../contracts/errors.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "./types.ts";

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

/**
 * The connection lookup of a pinned download: it answers only with the addresses the download's host was checked to resolve to, so the
 * connection cannot be moved to another address between the check and the request (DNS rebinding). Filtered by the requested family.
 */
export function pinnedLookup(addresses: ReadonlyArray<{ address: string; family: number }>): NonNullable<RequestOptions["lookup"]> {
  const pinned = (_hostname: string, rawOptions: number | { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    const options = typeof rawOptions === "number" ? { family: rawOptions } : rawOptions;
    const eligible = addresses.filter((record) => !options.family || record.family === options.family);
    if (eligible.length === 0) {
      callback(Object.assign(new Error("No checked address matches the requested family."), { code: "ENOTFOUND" }), "");
      return;
    }
    if (options.all) callback(null, eligible);
    else callback(null, eligible[0]?.address, eligible[0]?.family);
  };
  return pinned as NonNullable<RequestOptions["lookup"]>;
}

/** One download request over node:https, connected only to the checked addresses. A redirect or an oversized body is refused. */
function pinnedHttpRequest(request: HttpRequest, addresses: ReadonlyArray<{ address: string; family: number }>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const signals: AbortSignal[] = [];
    if (request.signal) signals.push(request.signal);
    if (request.timeoutMs !== undefined) signals.push(AbortSignal.timeout(request.timeoutMs));
    const req = httpsRequest(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        lookup: pinnedLookup(addresses),
        ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.resume();
          reject(new EngineError("provider", "the download answered with a redirect (3xx); redirects are refused, so the target was not fetched", { retryable: false }));
          return;
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
        }
        const chunks: Buffer[] = [];
        let received = 0;
        incoming.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (request.maxBodyBytes !== undefined && received > request.maxBodyBytes) {
            req.destroy();
            reject(new EngineError("invalid_input", `the download is above the ${request.maxBodyBytes} byte limit`, { retryable: false }));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("end", () => resolve({ status, headers, body: new Uint8Array(Buffer.concat(chunks)) }));
        incoming.once("error", reject);
      },
    );
    req.once("error", reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

export const fetchHttpTransport: HttpTransport = async (request) => {
  if (request.pinnedAddresses) return pinnedHttpRequest(request, request.pinnedAddresses);
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
