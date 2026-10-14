// PNG structure check. Tool output and provider output are untrusted: a frame is stored only when its signature,
// IHDR and IEND chunks are in place. This does not decode pixels (tests decode with pngjs).

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_LENGTH = 13;
const MIN_PNG_BYTES = 8 + 25 + 12;

export type PngSize = { width: number; height: number };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The pixel size of a well-formed PNG, or null when the bytes are not one. */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.byteLength < MIN_PNG_BYTES) {
    return null;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return null;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== IHDR_LENGTH || ascii(bytes, 12, 4) !== "IHDR") {
    return null;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) {
    return null;
  }
  // The file must end with the IEND chunk: length 0, then the type, then its CRC.
  if (ascii(bytes, bytes.byteLength - 8, 4) !== "IEND") {
    return null;
  }
  return { width, height };
}
