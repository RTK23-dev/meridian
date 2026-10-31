import { emailApiKey } from "../credentials/secret-settings.ts";
import type { Transport } from "../providers/http.ts";
import { gatedTransport } from "../providers/capability.ts";
import { sendWithRetry } from "../providers/http.ts";
import { emailApiUrlSetting } from "../config/server-settings.ts";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailResult =
  | { status: "sent"; provider: "test:email" | "real:email"; id: string }
  | { status: "NOT_CONFIGURED"; provider: "real:email"; error: string }
  | { status: "failed"; provider: "real:email"; error: string };

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
      const result = await sendWithRetry(transport ?? gatedTransport("email.send"), {
        method: "POST",
        url,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
      });
      if (!result.ok) {
        return { status: "failed", provider: "real:email", error: `Email provider returned ${result.status || "network"}.` };
      }
      const id = result.json && typeof result.json === "object" && typeof (result.json as { id?: unknown }).id === "string"
        ? (result.json as { id: string }).id
        : "sent";
      return { status: "sent", provider: "real:email", id };
    },
  };
}
