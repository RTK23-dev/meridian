import { FILE_RULES, MAX_MESSAGE_CHARS, type FileKind, type FilePurpose, type MediaTypeRule } from "../../lib/meridian/content-factory/model.ts";

/**
 * How the Create page runs what you type. In both modes your words and files are saved as the draft. Orchestrator then plans the piece
 * for you; Studio leaves each step to you, phase by phase, on the same page. Pure, so the rules can be tested without a browser.
 */
export const CREATE_MODES = ["orchestrator", "studio"] as const;
export type CreateMode = (typeof CREATE_MODES)[number];

export const CREATE_MODE_COPY: Record<CreateMode, { label: string; hint: string }> = {
  orchestrator: { label: "Meridian plans it", hint: "Meridian plans the piece for you." },
  studio: { label: "I set each step", hint: "You set each step yourself, phase by phase." },
};

/**
 * The first choice on an empty Create page: how the video is made. Claude Code makes it free on the person's own computer; Meridian makes it
 * with the workspace's keys (the composer below); a batch makes many variations at once on a brand's Content page.
 */
export const CREATE_WAYS = ["claude_code", "meridian", "batch"] as const;
export type CreateWay = (typeof CREATE_WAYS)[number];

export const CREATE_WAY_COPY: Record<CreateWay, { label: string; hint: string }> = {
  claude_code: { label: "Free, with Claude Code on your computer", hint: "Claude Code makes the video on your computer and saves it here. No key needed." },
  meridian: { label: "With Meridian (uses your keys)", hint: "Describe it below. Meridian plans it with your workspace's models, within its budget." },
  batch: { label: "Many variations at once", hint: "Turn one ready draft into a batch of variations, on a brand's Content page." },
};

/** Where the person's choice is remembered, per browser. */
export const CREATE_WAY_KEY = "meridian.create.way";

/** A stored way, or null when the value is missing or not one of the ways. */
export function wayOf(value: string | null | undefined): CreateWay | null {
  return typeof value === "string" && (CREATE_WAYS as readonly string[]).includes(value) ? (value as CreateWay) : null;
}

/** Whether the workspace has a text model to write with: its OpenRouter key's state as the credential resolver reports it. */
export type TextModelState = "loading" | "available" | "missing" | "unknown";

/** The OpenRouter key's state from the provider summaries. A summary that names no state, or a failed read, is unknown, never a guess. */
export function textModelStateOf({ loading, failed, credentialState }: { loading: boolean; failed: boolean; credentialState: string | undefined }): TextModelState {
  if (failed) return "unknown";
  if (loading) return "loading";
  if (credentialState === "usable") return "available";
  if (credentialState === "not_configured" || credentialState === "unusable") return "missing";
  return "unknown";
}

/**
 * The way the page opens on. A choice the person made in this browser wins. Otherwise Claude Code when the workspace has no text model, and
 * Meridian when it has one or when that cannot be told. Null while the key state is still loading, so the page does not flip under the person.
 */
export function defaultWay({ stored, textModel }: { stored: string | null; textModel: TextModelState }): CreateWay | null {
  const remembered = wayOf(stored);
  if (remembered) return remembered;
  if (textModel === "loading") return null;
  return textModel === "missing" ? "claude_code" : "meridian";
}

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

/**
 * The Create page's address: `?draft=<id>` reopens a draft, so a reload or a shared link comes back to it and its scripts. `?way=` opens the
 * empty page on one way to make it, so a link from elsewhere (Settings, the overview) lands on the free Claude Code option.
 */
export type CreateSearch = { draft?: string; way?: CreateWay };

export function createSearchOf(search: Record<string, unknown>): CreateSearch {
  const out: CreateSearch = {};
  const draft = search.draft;
  if (typeof draft === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(draft)) out.draft = draft;
  const way = wayOf(typeof search.way === "string" ? search.way : null);
  if (way) out.way = way;
  return out;
}
