import { extractText, getDocumentProxy } from "unpdf";
import { quarantineExternalText } from "./quarantine.ts";
import type { MaterialParse } from "./materials.ts";

const MAX_BYTES = 1_500_000;

/** Text extraction only. Instructions inside the PDF are dropped, never executed. */
export async function extractPdf(bytes: Uint8Array): Promise<MaterialParse> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    return { status: "failed", detail: "The PDF is empty or larger than 1.5 MB." };
  }
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return { status: "failed", detail: "The file is not a PDF." };
  }
  try {
    const document = await getDocumentProxy(bytes);
    const extracted = await extractText(document, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    const joined = pages
      .map((page, index) => `[page ${index + 1}]\n${page}`)
      .join("\n");
    const clean = quarantineExternalText(joined.slice(0, 20_000));
    if (clean.text.length < 20) {
      return { status: "failed", detail: "Not enough readable PDF text was left after removing instruction-like lines." };
    }
    return {
      status: "stored",
      text: clean.text,
      mime: "application/pdf",
      droppedLines: clean.droppedLines,
    };
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : "The PDF could not be read." };
  }
}
