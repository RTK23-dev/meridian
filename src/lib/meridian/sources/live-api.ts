/**
 * The transport a keyed source uses to call its provider. The default is the platform's fetch, read at the moment of each
 * call. A test injects a function that returns fixture responses, so no test makes a network request.
 *
 * A provider call that returns no usable answer throws a SourceCallError. Its `failure` is the health a run records for the
 * source: AUTH_FAILED (HTTP 401 or 403, or a provider code for a rejected key), RATE_LIMITED (HTTP 429, or a provider quota
 * code) or UNAVAILABLE (a network error, a timeout, another HTTP error, or a body that cannot be read). The message names the
 * source and the reason. It never contains the key or the request URL, so it is safe to show and to store.
 */
import type { SourceHealth } from "./types.ts";

export type SourceFetchInit = { method: "GET"; headers: Record<string, string>; signal: AbortSignal };
export type SourceFetch = (url: string, init: SourceFetchInit) => Promise<Response>;

export type CallFailure = "AUTH_FAILED" | "RATE_LIMITED" | "UNAVAILABLE";

/** How long one provider request may take before it counts as unavailable. */
export const SOURCE_REQUEST_TIMEOUT_MS = 15_000;

export class SourceCallError extends Error {
  readonly failure: CallFailure;

  constructor(failure: CallFailure, message: string) {
    super(message);
    this.name = "SourceCallError";
    this.failure = failure;
  }
}

/** Reads the provider's own error code from a failed response body. Returns undefined when the body names no known failure. */
export type ProviderFailureClassifier = (body: unknown) => CallFailure | undefined;

/** The transport to use: the one injected, or the platform's fetch read when the call is made. */
export function transportOf(injected?: SourceFetch): SourceFetch {
  return injected ?? ((url, init) => globalThis.fetch(url, init));
}

function failureForStatus(status: number): CallFailure {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UNAVAILABLE";
}

function messageFor(source: string, failure: CallFailure, status: number): string {
  if (failure === "AUTH_FAILED") return `${source} did not accept the saved key (HTTP ${status}). Save a valid key in Settings.`;
  if (failure === "RATE_LIMITED") return `${source} is rate limited (HTTP ${status}). Try again later.`;
  return `${source} returned HTTP ${status}. No results were read.`;
}

/**
 * One GET request to a provider, returning its parsed JSON object. Every failure is a SourceCallError. An empty answer is
 * returned as the parsed body, so the caller decides that zero results are an empty list.
 */
export async function getSourceJson(input: {
  source: string;
  fetch: SourceFetch;
  url: string;
  headers?: Record<string, string>;
  classify?: ProviderFailureClassifier;
}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "GET",
      headers: { accept: "application/json", ...input.headers },
      signal: AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SourceCallError("UNAVAILABLE", `${input.source} could not be reached. No results were read.`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = input.classify?.(body) ?? failureForStatus(response.status);
    throw new SourceCallError(failure, messageFor(input.source, failure, response.status));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceCallError("UNAVAILABLE", `${input.source} returned a response that could not be read.`);
  }
  return body as Record<string, unknown>;
}

/** The numeric `error.code` a provider returns in a failed body (Graph style), or undefined. */
export function providerErrorCode(body: unknown): number | undefined {
  const code = recordOf(recordOf(body)?.error)?.code;
  return typeof code === "number" ? code : undefined;
}

/** The `error.errors[].reason` strings a provider returns in a failed body (Google style). Empty when there are none. */
export function providerErrorReasons(body: unknown): string[] {
  const reasons = recordOf(recordOf(body)?.error)?.errors;
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((entry) => {
    const reason = recordOf(entry)?.reason;
    return typeof reason === "string" ? [reason] : [];
  });
}

/**
 * The health a test connection reports: HEALTHY when the one test request is accepted, otherwise the failure it raised.
 * The check is run only when someone asks for it. Source health during discovery stays key presence.
 */
export async function connectionHealth(input: {
  adapterId: string;
  source: string;
  check: () => Promise<unknown>;
}): Promise<SourceHealth> {
  const started = Date.now();
  const lastCheckedAt = new Date().toISOString();
  try {
    await input.check();
    return {
      adapterId: input.adapterId,
      status: "HEALTHY",
      latencyMs: Date.now() - started,
      message: `${input.source} accepted the saved key on one test request.`,
      lastCheckedAt,
    };
  } catch (error) {
    const failure: CallFailure = error instanceof SourceCallError ? error.failure : "UNAVAILABLE";
    const message = error instanceof SourceCallError ? error.message : `${input.source} could not be checked. No results were read.`;
    return { adapterId: input.adapterId, status: failure, latencyMs: Date.now() - started, message, lastCheckedAt };
  }
}

/** An integer within bounds. A missing or non-numeric value takes the fallback. */
export function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** Text trimmed and cut to a length. Provider text is data, so it is never trusted as markup. */
export function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** The value as an ISO time, or undefined when it does not parse. */
export function isoTimeOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** A value as a plain object, or undefined. Provider bodies are untrusted, so every field is read through this. */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The health of a source with no saved key: NOT_CONFIGURED, with the resolver's reason. */
export function notConfiguredHealth(adapterId: string, reason: string): SourceHealth {
  return {
    adapterId,
    status: "NOT_CONFIGURED",
    latencyMs: 0,
    message: reason,
    lastCheckedAt: new Date().toISOString(),
  };
}
