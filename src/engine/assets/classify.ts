// Maps what a provider call produced (an HTTP status, a thrown error, a failed job) to the contract's ProviderError (Bible
// 10.1 and 10.4). The router's retry rules read only the kind and the retryable flag, so this is the one place that decides
// them. Provider text is untrusted: it is shortened and never acted on, and it never carries a key.

import { EngineError } from "../contracts/errors.ts";
import type { ProviderError } from "../contracts/assets.ts";

export type ProviderErrorKind = ProviderError["kind"];

/**
 * Words that mark a refusal for content or safety. The shape of a policy refusal is not in PROVIDER_APIS.md, so this is a
 * heuristic over a 400 or a failed job's text. The owner's live run must record a real refusal and confirm it (STATUS.md).
 */
export const POLICY_PATTERN = /moderat|content[ _-]?polic|policy|safety|unsafe/i;

const MESSAGE_MAX_CHARS = 300;

/** A short, single-line excerpt of untrusted text, for a message only. */
export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_MAX_CHARS ? `${flat.slice(0, MESSAGE_MAX_CHARS)}...` : flat;
}

/** Thrown by an adapter when a provider answer is an error. It carries the classified error, so the router never guesses. */
export class ProviderCallError extends Error {
  readonly providerError: ProviderError;

  constructor(providerError: ProviderError) {
    super(providerError.message);
    this.name = "ProviderCallError";
    this.providerError = providerError;
  }
}

/** The ProviderError for a non-2xx answer. 429 is a rate limit, 408 and timeouts are timeouts, 5xx is a server error. */
export function providerErrorForStatus(status: number, body: string): ProviderError {
  const message = `the provider answered ${status}${body.trim() ? `: ${excerpt(body)}` : ""}`;
  if (status === 429) return { kind: "rate_limit", retryable: true, message };
  if (status === 408) return { kind: "timeout", retryable: true, message };
  if (status >= 500 && status !== 501) return { kind: "server", retryable: true, message };
  if (status === 400 || status === 422) {
    return POLICY_PATTERN.test(body)
      ? { kind: "content_policy", retryable: false, message }
      : { kind: "invalid_input", retryable: false, message };
  }
  return { kind: "unknown", retryable: false, message };
}

/** The ProviderError for a job that the provider reported as failed. A policy-like message is a content refusal. */
export function providerErrorForFailedJob(error: ProviderError): ProviderError {
  if (error.kind === "unknown" && POLICY_PATTERN.test(error.message)) {
    return { kind: "content_policy", retryable: false, message: error.message };
  }
  return error;
}

/** Any error thrown while calling a provider, mapped to a ProviderError. Unrecognised errors are unknown and not retried. */
export function classifyError(error: unknown): ProviderError {
  if (error instanceof ProviderCallError) return error.providerError;
  if (error instanceof EngineError) {
    const message = excerpt(error.message);
    if (error.kind === "invalid_input") return { kind: "invalid_input", retryable: false, message };
    if (error.kind === "provider" && error.retryable) return { kind: "server", retryable: true, message };
    return { kind: "unknown", retryable: false, message };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { kind: "timeout", retryable: true, message: "the request timed out" };
  }
  // A fetch that could not reach the host is a TypeError with a cause. Nothing else is treated as a network failure.
  if (error instanceof TypeError && error.cause !== undefined) {
    return { kind: "server", retryable: true, message: "the request could not reach the provider" };
  }
  return { kind: "unknown", retryable: false, message: "the provider call failed with an unrecognised error" };
}
