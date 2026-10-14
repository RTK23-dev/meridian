// Output validation for provider results (Bible 10.1 and the rule that provider outputs are untrusted, CLAUDE.md rule 8).
// Every byte and URL a provider returns is checked for type, size and shape before the router stores or caches it. A
// failed check returns a reason and never a partial value. Duration and codec of video are checked by the media functions
// (W4) after the bytes are stored, because a URL alone cannot tell them.

export const OUTPUT_LIMITS = {
  imageMinBytes: 1024,
  imageMaxBytes: 32 * 1024 * 1024,
  speechMinBytes: 1024,
  speechMaxBytes: 64 * 1024 * 1024,
  urlMaxLength: 2048,
} as const;

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export const SPEECH_MEDIA_TYPE = "audio/mpeg" as const;

export type Normalised<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** The media type without parameters, lower-cased ("image/png; charset=x" is "image/png"). */
function bareMediaType(declared: string): string {
  return declared.split(";")[0]?.trim().toLowerCase() ?? "";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** The image type the first bytes name, or null when they name none of the accepted types. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/**
 * A still image from a provider. The declared type must be an accepted raster type and must match the bytes; SVG and
 * anything else is refused. The size must sit between the limits.
 */
export function normaliseImage(bytes: Uint8Array, declaredMediaType: string): Normalised<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
  const declared = bareMediaType(declaredMediaType);
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(declared)) {
    return fail(`image media type ${declared || "(none)"} is not accepted`);
  }
  if (bytes.length < OUTPUT_LIMITS.imageMinBytes || bytes.length > OUTPUT_LIMITS.imageMaxBytes) {
    return fail(`image size ${bytes.length} bytes is outside ${OUTPUT_LIMITS.imageMinBytes} to ${OUTPUT_LIMITS.imageMaxBytes}`);
  }
  const sniffed = sniffImage(bytes);
  if (sniffed !== declared) return fail(`image bytes are ${sniffed ?? "unknown"}, not the declared ${declared}`);
  return { ok: true, value: { bytes, mediaType: sniffed } };
}

/**
 * Speech from a provider as MP3. Accepted when the bytes start with an ID3 tag or an MPEG frame sync. Duration is unknown
 * here and is measured by the media functions after storage.
 */
export function normaliseSpeech(bytes: Uint8Array, declaredMediaType: string): Normalised<{ bytes: Uint8Array; mediaType: typeof SPEECH_MEDIA_TYPE }> {
  const declared = bareMediaType(declaredMediaType);
  if (declared !== SPEECH_MEDIA_TYPE) return fail(`speech media type ${declared || "(none)"} is not ${SPEECH_MEDIA_TYPE}`);
  if (bytes.length < OUTPUT_LIMITS.speechMinBytes || bytes.length > OUTPUT_LIMITS.speechMaxBytes) {
    return fail(`speech size ${bytes.length} bytes is outside ${OUTPUT_LIMITS.speechMinBytes} to ${OUTPUT_LIMITS.speechMaxBytes}`);
  }
  const id3 = startsWith(bytes, [0x49, 0x44, 0x33]);
  const frameSync = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
  if (!id3 && !frameSync) return fail("speech bytes do not start with an MP3 header");
  return { ok: true, value: { bytes, mediaType: SPEECH_MEDIA_TYPE } };
}

/**
 * A URL a provider returned. It must be https, carry no user information and stay within the length limit. Nothing else
 * about the host is trusted: a key is never attached to it (the gateway only authenticates its own provider host).
 */
export function normaliseHttpsUrl(text: string): Normalised<string> {
  if (text.length === 0 || text.length > OUTPUT_LIMITS.urlMaxLength) return fail("URL is empty or too long");
  if (/\s/.test(text) || text.split("").some((character) => character.charCodeAt(0) < 0x20)) {
    return fail("URL contains whitespace or control characters");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("URL does not parse");
  }
  if (url.protocol !== "https:") return fail("URL is not https");
  if (url.username !== "" || url.password !== "") return fail("URL carries user information");
  if (url.hostname.length === 0) return fail("URL has no host");
  return { ok: true, value: url.toString() };
}

/** Base64 decoded only when the text is canonical base64 (no stray characters, correct padding). */
export function decodeBase64Strict(text: string): Normalised<Uint8Array> {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    return fail("payload is not canonical base64");
  }
  const bytes = new Uint8Array(Buffer.from(text, "base64"));
  if (bytes.length === 0) return fail("base64 payload decoded to no bytes");
  return { ok: true, value: bytes };
}
