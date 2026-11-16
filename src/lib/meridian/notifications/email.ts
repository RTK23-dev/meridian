import { emailApiKey } from "../credentials/secret-settings.ts";
import type { Transport } from "../providers/http.ts";
import { liveTransport, sendWithRetry } from "../providers/http.ts";
import { emailApiUrlSetting } from "../config/server-settings.ts";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Sent as the Idempotency-Key header, so a repeat of the same send is recognised by the provider. */
  idempotencyKey?: string;
};

export type EmailResult =
  | { status: "sent"; provider: "test:email" | "real:email"; id: string }
  | { status: "NOT_CONFIGURED"; provider: "real:email"; error: string }
  /** The provider answered with a refusal (4xx): the email was not sent. */
  | { status: "failed"; provider: "real:email"; error: string }
  /** No answer (timeout, network error) or a 5xx: the email may or may not have been sent. */
  | { status: "uncertain"; provider: "real:email"; error: string };

export type EmailProvider = {
  id: "test:email" | "real:email";
  send: (message: EmailMessage) => Promise<EmailResult>;
};

export function testEmailProvider(sent: EmailMessage[] = []): EmailProvider {
  return {
    id: "test:email",
    async send(message) {
      sent.push(message);
      return { status: "sent", provider: "test:email", id: `test:email:${sent.length}` };
    },
  };
}

/** HTTP email API. Missing URL or key does not pretend the message was sent. */
export function realEmailProvider(env?: { url?: string; key?: string }, transport?: Transport): EmailProvider {
  return {
    id: "real:email",
    async send(message) {
      const url = (env?.url ?? emailApiUrlSetting())?.trim() ?? "";
      const key = (env?.key ?? emailApiKey())?.trim() ?? "";
      if (!url || !key) {
        return { status: "NOT_CONFIGURED", provider: "real:email", error: "Email delivery is not configured." };
      }
      const result = await sendWithRetry(transport ?? liveTransport(), {
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
      });
      if (!result.ok) {
        // Only a 4xx is a clear refusal. A status of 0 (no answer, thrown transport error) or a 5xx leaves the outcome unknown.
        const refused = result.status >= 400 && result.status < 500;
        return {
          status: refused ? "failed" : "uncertain",
          provider: "real:email",
          error: `Email provider returned ${result.status || "no answer"}.`,
        };
      }
      const id = result.json && typeof result.json === "object" && typeof (result.json as { id?: unknown }).id === "string"
        ? (result.json as { id: string }).id
        : "sent";
      return { status: "sent", provider: "real:email", id };
    },
  };
}
