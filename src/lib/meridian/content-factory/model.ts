/**
 * Content Factory: the shapes and the plain rules of the /content-factory screen. An admin starts a video from any idea in a chat thread
 * (messages, files from their computer, references to records on other Meridian pages), then asks for one video. No server imports here,
 * so the screen, the server functions and the tests share these rules.
 */

/** Beat roles of a script line, as the engine's request contract names them (src/engine/contracts/request.ts BEAT_ROLES). */
export const SCRIPT_ROLES = ["hook", "setup", "item", "proof", "twist", "payoff", "cta"] as const;
export type ScriptRole = (typeof SCRIPT_ROLES)[number];

/** The genes a request may keep from the reference (src/engine/contracts/request.ts GENE_IDS). */
export const KEEPABLE_GENES = [
  "hook_mechanism",
  "voice_persona",
  "emotional_arc",
  "structure",
  "proof_device",
  "edit_grammar",
  "conversion_move",
  "pacing",
  "caption_style",
] as const;
export type KeepableGene = (typeof KEEPABLE_GENES)[number];

export const GENE_LABELS: Record<KeepableGene, string> = {
  hook_mechanism: "Hook",
  voice_persona: "Voice persona",
  emotional_arc: "Emotional arc",
  structure: "Structure",
  proof_device: "Proof device",
  edit_grammar: "Edit grammar",
  conversion_move: "Conversion move",
  pacing: "Pacing",
  caption_style: "Caption style",
};

export const PRIORITIES = ["rush", "normal", "batch"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The Meridian pages a source can come from. Each is read only, with its existing reader. */
export const SOURCE_PAGES = ["brain", "product", "library", "page", "market"] as const;
export type SourcePage = (typeof SOURCE_PAGES)[number];

export const SOURCE_PAGE_LABELS: Record<SourcePage, string> = {
  brain: "Brand brain",
  product: "Products",
  library: "Library",
  page: "Theme pages",
  market: "Market research",
};

export const FILE_PURPOSES = ["reference_video", "material"] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export type FileKind = "video" | "image" | "text" | "document";

/** One accepted media type. A binary type has a size limit; a text file is limited by its characters (TEXT_FILE_MAX_CHARS) instead. */
export type MediaTypeRule = { mediaType: string; kind: FileKind; extension: string; maxBytes?: number };

/** The types a session accepts. Binary types are read from their bytes; a text type is named by the file's extension (files.ts). */
export const FILE_RULES: readonly MediaTypeRule[] = [
  { mediaType: "video/mp4", kind: "video", extension: "mp4", maxBytes: 40_000_000 },
  { mediaType: "video/quicktime", kind: "video", extension: "mov", maxBytes: 40_000_000 },
  { mediaType: "video/webm", kind: "video", extension: "webm", maxBytes: 40_000_000 },
  { mediaType: "image/png", kind: "image", extension: "png", maxBytes: 10_000_000 },
  { mediaType: "image/jpeg", kind: "image", extension: "jpg", maxBytes: 10_000_000 },
  { mediaType: "image/webp", kind: "image", extension: "webp", maxBytes: 10_000_000 },
  { mediaType: "text/plain", kind: "text", extension: "txt" },
  { mediaType: "text/markdown", kind: "text", extension: "md" },
  { mediaType: "text/csv", kind: "text", extension: "csv" },
  { mediaType: "application/json", kind: "text", extension: "json" },
  { mediaType: "application/pdf", kind: "document", extension: "pdf", maxBytes: 10_000_000 },
];

/** The largest binary file. The server refuses a larger upload before it decodes it. */
export const MAX_FILE_BYTES = Math.max(...FILE_RULES.map((rule) => rule.maxBytes ?? 0));
/** The base64 length of the largest file, with its padding. */
export const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/** A text file is read into the brief when it has at most this many characters: the engine's brief source limit (BRIEF_SOURCE_TEXT_MAX). */
export const TEXT_FILE_MAX_CHARS = 4000;

/** What the session says about a PDF whose text was not readable. A readable PDF within the text limit is used in the brief. */
export const PDF_TEXT_NOTE = "PDF text could not be read, so it is not in the brief. The file is kept with the session.";

/** Stored instead of brief text when a PDF was read and is longer than the brief limit. It is not brief text. */
export const PDF_OVER_LIMIT_CONTENT = "pdf-over-brief-limit";

/** What the session says when the PDF was read and excluded because it is too long. */
export const PDF_TEXT_LIMIT_NOTE = "PDF text is longer than the brief allows, so it is not in the brief. The file is kept with the session.";

export const ACCEPTED_FILE_LABEL = `MP4, MOV or WEBM video up to 40 MB, PNG, JPEG or WEBP images and PDFs up to 10 MB, and text files (TXT, Markdown, CSV or JSON) of at most ${TEXT_FILE_MAX_CHARS} characters`;

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TITLE_CHARS = 120;
export const MAX_SNAPSHOT_CHARS = 600;
/** The longest direction a reviewer can give one shot. The engine keeps the same limit (src/engine/jobs/remake.ts), and a test keeps them equal. */
export const REMAKE_DIRECTION_MAX_CHARS = 280;
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 180;

export type SessionStatus = "draft" | "started";

export type SessionSummary = {
  id: string;
  title: string;
  brandId: string | null;
  status: SessionStatus;
  engineRequestId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionSettings = {
  budgetUsd: number | null;
  maxSeconds: number | null;
  language: string | null;
  priority: Priority | null;
  keepGenes: KeepableGene[];
};

export type FileAttachment = {
  id: string;
  kind: "file";
  messageId: string;
  purpose: FilePurpose;
  fileName: string;
  storageObjectId: string | null;
  storageKey: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  /** A text file's content, read into the brief (at most TEXT_FILE_MAX_CHARS characters). Null for every other file. */
  content: string | null;
  createdAt: string;
};

export type SourceAttachment = {
  id: string;
  kind: "source";
  messageId: string;
  page: SourcePage;
  brandId: string;
  recordId: string;
  snapshot: string;
  createdAt: string;
};

export type Attachment = FileAttachment | SourceAttachment;

export type Message = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  text: string;
  beatRole: ScriptRole | null;
  createdAt: string;
  attachments: Attachment[];
};

export type SessionDetail = SessionSummary & {
  settings: SessionSettings;
  lastRefusal: string[];
  startedAt: string | null;
  messages: Message[];
};

export type SourceResult = { page: SourcePage; brandId: string; recordId: string; title: string; snapshot: string };

export function isScriptRole(value: unknown): value is ScriptRole {
  return typeof value === "string" && (SCRIPT_ROLES as readonly string[]).includes(value);
}

export function isKeepableGene(value: unknown): value is KeepableGene {
  return typeof value === "string" && (KEEPABLE_GENES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export function isSourcePage(value: unknown): value is SourcePage {
  return typeof value === "string" && (SOURCE_PAGES as readonly string[]).includes(value);
}

export function isFilePurpose(value: unknown): value is FilePurpose {
  return typeof value === "string" && (FILE_PURPOSES as readonly string[]).includes(value);
}

/** One line of plain text, collapsed and cut to `max` characters, for a snapshot shown to the user. */
export function snapshotText(parts: Array<string | null | undefined>, max = MAX_SNAPSHOT_CHARS): string {
  const text = parts
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A byte count in plain words. */
export function bytesLabel(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}
