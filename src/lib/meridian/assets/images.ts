const MAX_BYTES = 800_000;

export type ImageInspection =
  | { ok: true; mime: "image/png" | "image/jpeg" | "image/webp"; bytes: number }
  | { ok: false; detail: string };

/** Accept only PNG, JPEG, and WEBP, checked from the bytes rather than the file name. */
export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (bytes.length < 12 || bytes.length > MAX_BYTES) {
    return { ok: false, detail: "The image is empty or larger than 800 KB. It was not stored." };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ok: true, mime: "image/png", bytes: bytes.length };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ok: true, mime: "image/jpeg", bytes: bytes.length };
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ok: true, mime: "image/webp", bytes: bytes.length };
  }
  return { ok: false, detail: "Only PNG, JPEG, and WEBP are stored. The file was not saved." };
}
