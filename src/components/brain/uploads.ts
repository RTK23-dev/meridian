/** File checks and upload outcomes for the brain screen. The server still checks every file; these checks only give early feedback. */

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 800 * 1024;
export const LOGO_LIMIT_MESSAGE = "Choose a PNG, JPEG, or WEBP under 800 KB.";

export const DOCUMENT_EXTENSIONS = [".txt", ".md", ".docx", ".pdf"] as const;
export const DOCUMENT_LIMIT_MESSAGE = "Choose a plain text, Markdown, DOCX, or PDF file.";

/** Returns the message to show, or null when the logo can be uploaded. */
export function validateLogoFile(file: { type: string; size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return LOGO_LIMIT_MESSAGE;
  if (file.size > LOGO_MAX_BYTES) return LOGO_LIMIT_MESSAGE;
  return null;
}

export function isSupportedDocument(file: { name: string }): boolean {
  const name = file.name.trim().toLowerCase();
  return DOCUMENT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Returns the message to show, or null when the document can be stored. */
export function documentProblem(file: { name: string }): string | null {
  return isSupportedDocument(file) ? null : DOCUMENT_LIMIT_MESSAGE;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type StoreOutcome = { status: "stored" | "failed"; detail: string; droppedLines?: number };
export type SuggestOutcome =
  | { status: "stored"; saved: number; message: string }
  | { status: "unavailable" | "failed"; message: string };
export type UploadSummary = { tone: "success" | "neutral" | "danger"; message: string };

/**
 * One message for an upload. Store failures and suggestion failures are shown as failures. "No model
 * configured" is information, not a failure, and nothing is claimed as inferred.
 */
export function summariseUpload(store: StoreOutcome, suggest: SuggestOutcome | null): UploadSummary {
  if (store.status === "failed") return { tone: "danger", message: store.detail };
  const dropped = store.droppedLines && store.droppedLines > 0
    ? ` ${store.droppedLines} instruction-like line${store.droppedLines === 1 ? " was" : "s were"} removed.`
    : "";
  const stored = `${store.detail}${dropped}`;
  if (!suggest) return { tone: "neutral", message: stored };
  if (suggest.status === "stored") {
    if (suggest.saved === 0) return { tone: "neutral", message: `Stored. ${suggest.message}` };
    return { tone: "success", message: suggest.message };
  }
  if (suggest.status === "unavailable") return { tone: "neutral", message: `Stored. ${suggest.message}` };
  return { tone: "danger", message: `Stored, but suggestions failed. ${suggest.message}` };
}

/** Reads a file as base64 without the data-URL prefix. The server expects base64 only. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      resolve(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw);
    };
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}
