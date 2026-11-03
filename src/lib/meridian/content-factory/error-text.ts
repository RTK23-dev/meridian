// The reason shown for a failed engine, store or decision call. Provider and store messages are untrusted text: keys are removed and the
// text is shortened before a person sees it, so a raw provider message never reaches the screen whole.
import { redactSecrets } from "../observability/redact.ts";

const MAX_CHARS = 300;

/** The error's message with secrets removed, on one line and shortened, or the fallback when there is no message. */
export function plainErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const cleaned = redactSecrets(raw).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  return cleaned || fallback;
}
