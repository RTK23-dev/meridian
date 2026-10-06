import { publicUrlIssue } from "../sources/public-url.ts";

const MEDIA_HOSTS = ["fbcdn.net", "cdninstagram.com", "facebook.com"];

/** Extracts only explicit video links from a Meta snapshot; never guesses a media URL. */
export function metaSnapshotVideoUrl(html: string): string | null {
  const candidates = [
    ...html.matchAll(/<meta\b[^>]*\b(?:property|name)=["'](?:og:video|og:video:url|twitter:player:stream)["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/<source\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ];
  for (const match of candidates) {
    const raw = (match[1] ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", "\"").trim();
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || publicUrlIssue(url.toString()) || !MEDIA_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function isMp4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  return String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
}
