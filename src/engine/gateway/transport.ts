// The one place in src/engine that touches the network (gateway/boundaries.test.ts enforces it). Everything else gets an
// HttpTransport from the gateway, and tests inject recorded responses instead of this one.

import type { HttpTransport } from "./types.ts";

export const fetchHttpTransport: HttpTransport = async (request) => {
  const signals: AbortSignal[] = [];
  if (request.signal) signals.push(request.signal);
  if (request.timeoutMs !== undefined) signals.push(AbortSignal.timeout(request.timeoutMs));
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : typeof request.body === "string" ? request.body : new Uint8Array(request.body),
    signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
};
