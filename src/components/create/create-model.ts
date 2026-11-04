import { MAX_MESSAGE_CHARS } from "../../lib/meridian/content-factory/model.ts";

/**
 * How the Create page runs what you type. Orchestrator takes your words, plans the piece and makes it, and saves it as a draft. Studio
 * leaves every control to you, on the same page. Pure, so the rules can be tested without a browser.
 */
export const CREATE_MODES = ["orchestrator", "studio"] as const;
export type CreateMode = (typeof CREATE_MODES)[number];

export const CREATE_MODE_COPY: Record<CreateMode, { label: string; hint: string }> = {
  orchestrator: { label: "Orchestrator", hint: "Describe it. Meridian plans and makes the piece for you." },
  studio: { label: "Studio", hint: "Set each control yourself, on this page." },
};

/** Starting points a person can tap, so an empty page still shows what it can make. */
export const CREATE_SUGGESTIONS = [
  "A 30-second product video from one product page",
  "A draft from a reference video I already have",
  "Ten variations of one draft for a batch",
] as const;

/** Why the message cannot be sent yet, in words a person can act on. Null when it can be sent. */
export function sendBlock({ text, mode, canAdmin, busy }: { text: string; mode: CreateMode; canAdmin: boolean; busy: boolean }): string | null {
  if (mode === "studio") return "Studio works on the controls on this page. Switch to Orchestrator to write it out.";
  if (!canAdmin) return "Only a workspace admin can start a draft.";
  if (busy) return "Sending.";
  if (text.trim() === "") return "Write what you want to make.";
  if (text.length > MAX_MESSAGE_CHARS) return `Keep it to ${MAX_MESSAGE_CHARS} characters.`;
  return null;
}

/** The draft's title: the first line of the message, shortened. */
export function titleFor(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line === "") return "New draft";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
