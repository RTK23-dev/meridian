import { FILE_RULES, MAX_MESSAGE_CHARS, type FileKind, type FilePurpose, type MediaTypeRule } from "../../lib/meridian/content-factory/model.ts";

/**
 * How the Create page runs what you type. In both modes your words and files are saved as the draft. Orchestrator then plans the piece
 * for you; Studio leaves each step to you, phase by phase, on the same page. Pure, so the rules can be tested without a browser.
 */
export const CREATE_MODES = ["orchestrator", "studio"] as const;
export type CreateMode = (typeof CREATE_MODES)[number];

export const CREATE_MODE_COPY: Record<CreateMode, { label: string; hint: string }> = {
  orchestrator: { label: "Orchestrator", hint: "Meridian plans the piece for you." },
  studio: { label: "Studio", hint: "You set each step yourself, phase by phase." },
};

/** Starting points a person can tap, so an empty page still shows what it can make. */
export const CREATE_SUGGESTIONS = [
  "A 30-second product video from one product page",
  "A draft from a reference video I already have",
  "Ten variations of one draft for a batch",
] as const;

/** The composer's placeholder in each mode. */
export const CREATE_PLACEHOLDER: Record<CreateMode, string> = {
  orchestrator: "Describe the video, the product or the reference",
  studio: "Describe what to make; you set each step below",
};

/** Why the message cannot be sent yet, in words a person can act on. Null when it can be sent. Both modes send the same way. */
export function sendBlock({ text, canAdmin, busy }: { text: string; mode?: CreateMode; canAdmin: boolean; busy: boolean }): string | null {
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

/** The reference a file of this kind can be: a video is the reference video, a picture a reference image. Text and PDFs are material only. */
export function referencePurposeOf(kind: FileKind): Exclude<FilePurpose, "material"> | null {
  if (kind === "video") return "reference_video";
  if (kind === "image") return "reference_image";
  return null;
}

/** The purpose after a person taps the file's Reference/Material switch. A file that cannot be a reference stays material. */
export function togglePurposeOf(kind: FileKind, purpose: FilePurpose): FilePurpose {
  const reference = referencePurposeOf(kind);
  if (reference === null) return "material";
  return purpose === "material" ? reference : "material";
}

/** The Create page's address: `?draft=<id>` reopens a draft, so a reload or a shared link comes back to it and its scripts. */
export type CreateSearch = { draft?: string };

export function createSearchOf(search: Record<string, unknown>): CreateSearch {
  const draft = search.draft;
  return typeof draft === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(draft) ? { draft } : {};
}
