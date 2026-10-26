/**
 * What each named discovery source can really do in this release, in words a person can use. This is a fixed table that follows the
 * adapters' own health messages. A saved key is never taken as proof that a source works, and nothing here is live-verified.
 */

export type SourceCapability = {
  /** True when a saved developer key makes this source search by phrase. */
  searchesByPhrase: boolean;
  /** What the source is for, in one sentence. */
  summary: string;
  /** What to do instead, when the source does not search. */
  instead?: string;
};

const NOT_AVAILABLE = "Not available in this release. A saved key does not change that, and none is needed.";

export const SOURCE_CAPABILITIES: Record<string, SourceCapability> = {
  youtube: { searchesByPhrase: true, summary: "Searches public videos by phrase, using your own YouTube Data API key." },
  meta_ad_library: { searchesByPhrase: true, summary: "Searches public ads by phrase, using your own Meta developer token." },
  search: { searchesByPhrase: true, summary: "Searches Google by phrase through SerpAPI, using your own SerpAPI key." },
  tiktok: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload the video or paste its text, or add a page the site allows reading." },
  instagram: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload the post or paste its text. Instagram pages can refuse automated reads." },
  twitter: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload a screenshot or paste the text of the post." },
  facebook: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload the post or paste its text." },
  pinterest: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload the image or paste its text." },
  linkedin: { searchesByPhrase: false, summary: NOT_AVAILABLE, instead: "Upload the post or paste its text." },
  reddit: { searchesByPhrase: false, summary: "Search is not available. A public post URL can be read when the site allows it.", instead: "Paste the post URL." },
  licensed: { searchesByPhrase: false, summary: "Not available in this release. There is no client for licensed data.", instead: "Upload the data you hold the rights to." },
};

export type SourceGroups<T extends { adapterId: string }> = { search: T[]; unavailable: T[] };

/** Splits the listed sources into the ones that can search with a key and the ones that cannot do anything with one. */
export function groupSources<T extends { adapterId: string }>(sources: readonly T[]): SourceGroups<T> {
  const search: T[] = [];
  const unavailable: T[] = [];
  for (const source of sources) (SOURCE_CAPABILITIES[source.adapterId]?.searchesByPhrase ? search : unavailable).push(source);
  return { search, unavailable };
}

const SOCIAL_HOSTS: ReadonlyArray<{ id: string; label: string; hosts: readonly string[] }> = [
  { id: "instagram", label: "Instagram", hosts: ["instagram.com"] },
  { id: "tiktok", label: "TikTok", hosts: ["tiktok.com"] },
  { id: "twitter", label: "X (Twitter)", hosts: ["twitter.com", "x.com"] },
  { id: "facebook", label: "Facebook", hosts: ["facebook.com", "fb.com"] },
  { id: "pinterest", label: "Pinterest", hosts: ["pinterest.com"] },
  { id: "linkedin", label: "LinkedIn", hosts: ["linkedin.com"] },
];

/**
 * The social platform a pasted URL belongs to, or null. None of these has a URL reader in this release: the page is tried as an ordinary
 * public page, and the site's robots.txt or bot check decides. A key for the platform changes nothing, so none is ever asked for.
 */
export function socialPlatformOf(seed: string): { id: string; label: string } | null {
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(seed.trim()) ? seed.trim() : `https://${seed.trim()}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const found = SOCIAL_HOSTS.find((platform) => platform.hosts.some((name) => host === name || host.endsWith(`.${name}`)));
  return found ? { id: found.id, label: found.label } : null;
}
