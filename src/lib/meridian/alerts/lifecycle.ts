import type { AlertEvent, DeliveryTarget } from "./deliver.ts";
import { publicUrlIssue } from "../sources/public-url.ts";

export const MAX_DELIVERY_ATTEMPTS = 3;

export function alertSeverity(code: string): AlertEvent["severity"] {
  if (code.endsWith(".stopped") || code === "storage.failed" || code === "dead_letter.growth") return "critical";
  return "warning";
}

export function deliveryUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    // An https alert goes to a public host only. A private or metadata address would let an admin probe the network through the
    // delivery status, so the same host rules that govern page reads apply here.
    if (parsed.protocol === "https:") return publicUrlIssue(url) === null;
    if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Send, wait, or dead-letter. A missing target is not a delivered page.
 *
 * Attempt states (delivery_attempts.status): 'sending' is written before the request; the request ends it as 'sent' (2xx), 'failed'
 * (4xx: not taken, may be tried again) or 'uncertain' (no answer, or 5xx: it may have been received). 'sent' and 'uncertain' are
 * final: nothing is sent again by a job. An uncertain attempt waits for a person to check the receiving system. A 'sending' attempt is
 * another delivery in flight, or one whose worker stopped mid-request, so it is not sent again either.
 */
export function deliveryPlan(
  attempts: { status: string }[],
  target: DeliveryTarget,
): { action: "send" | "dead" | "skip"; status: "pending" | "dead" | "NOT_CONFIGURED" | "sent" | "uncertain" | "sending" } {
  if (attempts.some((item) => item.status === "sent")) return { action: "skip", status: "sent" };
  if (attempts.some((item) => item.status === "uncertain")) return { action: "skip", status: "uncertain" };
  if (attempts.some((item) => item.status === "sending")) return { action: "skip", status: "sending" };
  if (target.kind === "none" || !("url" in target) || !target.url?.trim()) return { action: "skip", status: "NOT_CONFIGURED" };
  if (!deliveryUrlAllowed(target.url)) return { action: "dead", status: "dead" };
  const failed = attempts.filter((item) => item.status === "failed").length;
  if (failed >= MAX_DELIVERY_ATTEMPTS) return { action: "dead", status: "dead" };
  return { action: "send", status: "pending" };
}
