import { FILE_RULES, MAX_MESSAGE_CHARS, type MediaTypeRule } from "../../lib/meridian/content-factory/model.ts";

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

/** The file types the picker offers, from the same list the server checks, so the picker and the server never disagree. */
export const CREATE_ACCEPT = FILE_RULES.flatMap((rule) => [rule.mediaType, `.${rule.extension}`]).join(",");

/** The rule a file falls under, by its type, or by its extension for a text file a browser may leave untyped. Null when Meridian does not take it. */
export function ruleFor(file: { type: string; name: string }): MediaTypeRule | null {
  const byType = FILE_RULES.find((rule) => rule.mediaType === file.type);
  if (byType) return byType;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_RULES.find((rule) => rule.kind === "text" && rule.extension === extension) ?? null;
}

/** Why a file cannot be attached, in words a person can act on. Null when it can. */
export function fileProblem(file: { type: string; name: string; size: number }): string | null {
  const rule = ruleFor(file);
  if (!rule) return `${file.name} is not a type Meridian takes. Use a video, an image, a PDF or a text file.`;
  if (rule.maxBytes !== undefined && file.size > rule.maxBytes) return `${file.name} is larger than ${Math.round(rule.maxBytes / 1_000_000)} MB.`;
  return null;
}

/** A video is a reference to copy from; anything else is material for the draft. A person can change it on the file. */
export function purposeFor(file: { type: string }): "reference_video" | "material" {
  return file.type.startsWith("video/") ? "reference_video" : "material";
}
