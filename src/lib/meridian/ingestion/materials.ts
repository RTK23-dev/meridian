import { inflateRawSync } from "node:zlib";
import { quarantineExternalText } from "./quarantine.ts";

export type MaterialParse =
  | { status: "stored"; text: string; mime: string; droppedLines: number }
  | { status: "failed"; detail: string };

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 20_000;

/** Text and DOCX only. PDF is refused rather than guessed. */
export function parseMaterial(input: { filename: string; mime: string; base64?: string; text?: string }): MaterialParse {
  const filename = input.filename.trim().toLowerCase();
  const mime = input.mime.trim().toLowerCase();
  if (mime === "application/pdf" || filename.endsWith(".pdf")) {
    return { status: "failed", detail: "PDF text extraction is not connected. Paste the text instead. Nothing was inferred from the file." };
  }
  if (input.text && !input.base64) {
    return finish("text/plain", input.text);
  }
  if (!input.base64) return { status: "failed", detail: "No file contents were provided." };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.base64, "base64");
  } catch {
    return { status: "failed", detail: "The file was not valid base64." };
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    return { status: "failed", detail: "The file is empty or larger than 1.5 MB." };
  }
  if (mime.includes("wordprocessingml") || filename.endsWith(".docx")) {
    try {
      return finish("application/vnd.openxmlformats-officedocument.wordprocessingml.document", extractDocxText(bytes));
    } catch (error) {
      return { status: "failed", detail: error instanceof Error ? error.message : "The DOCX could not be read." };
    }
  }
  if (mime.startsWith("text/") || filename.endsWith(".txt") || filename.endsWith(".md")) {
    return finish(mime.startsWith("text/") ? mime : "text/plain", bytes.toString("utf8"));
  }
  return { status: "failed", detail: "That file type is not supported. Use plain text, DOCX, or PDF, or paste the text." };
}

/** PDF bytes go through the extractor. A pasted string named .pdf is still refused. */
export async function parseMaterialDocument(input: { filename: string; mime: string; base64?: string; text?: string }): Promise<MaterialParse> {
  const filename = input.filename.trim().toLowerCase();
  const mime = input.mime.trim().toLowerCase();
  if ((mime === "application/pdf" || filename.endsWith(".pdf")) && input.base64) {
    const { extractPdf } = await import("./pdf.ts");
    return extractPdf(Buffer.from(input.base64, "base64"));
  }
  return parseMaterial(input);
}

function finish(mime: string, raw: string): MaterialParse {
  const clean = quarantineExternalText(raw.slice(0, MAX_TEXT));
  if (clean.text.length < 20) {
    return { status: "failed", detail: "Not enough readable text was left after removing instruction-like lines." };
  }
  return { status: "stored", text: clean.text, mime, droppedLines: clean.droppedLines };
}

function extractDocxText(bytes: Buffer): string {
  const xml = unzipEntry(bytes, "word/document.xml");
  if (!xml) throw new Error("That DOCX has no document body, or the zip is not readable.");
  const text = xml
    .replace(/<w:p[ >]/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'");
  return text;
}

function unzipEntry(bytes: Buffer, wanted: string): string | null {
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    if (flags & 0x8) throw new Error("That DOCX uses a streaming zip. Paste the text instead.");
    if (dataStart + compressed > bytes.length) throw new Error("The DOCX is truncated.");
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (name === wanted) {
      if (method === 0) return data.toString("utf8");
      if (method === 8) return inflateRawSync(data).toString("utf8");
      throw new Error("That DOCX uses a compression method Meridian does not read.");
    }
    offset = dataStart + compressed;
  }
  return null;
}
