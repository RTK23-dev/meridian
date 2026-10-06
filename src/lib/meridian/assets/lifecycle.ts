/** Fingerprint for stored creative text. Not a signed checksum from an object store. */
export function contentHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export type StoredAsset = {
  version: number;
  storageKey: string;
  contentHash: string;
  mimeType: "text/plain";
  source: "composed_text";
  status: "stored";
};

/** Records the text we actually have. It does not upload to external object storage. */
export function ingestComposedText(creativeId: string, text: string): StoredAsset {
  return {
    version: 1,
    storageKey: `creative/${creativeId}/v1.txt`,
    contentHash: contentHash(text),
    mimeType: "text/plain",
    source: "composed_text",
    status: "stored",
  };
}
