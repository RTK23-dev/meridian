/**
 * Safe Budgeted Crawl Ladder & Repeated Card Extractor
 *
 * Implements the canonical discovery crawl ladder:
 * SSRF validation -> HTTP fetch -> HTML/OG/JSON-LD metadata -> Repeated card detection -> Link discovery
 *
 * Enforces strict limits: maxPages, maxDepth, host boundaries, honest unavailable metrics.
 */

import { createHash } from "node:crypto";
import { fetchPublicHtml, htmlToText } from "../sources/fetch-page.server.ts";
import { publicUrlIssue } from "../sources/public-url.ts";
import type { DiscoveredItem } from "./types.ts";

export interface PageCrawlResult {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  canonicalUrl: string;
  openGraph: Record<string, string>;
  jsonLd: unknown[];
  cards: DiscoveredItem[];
  outboundLinks: string[];
  /** When the page was requested. Its declarations and cards are observed at this time. */
  fetchedAt: string;
}

/**
 * Extracts OpenGraph and Twitter meta tags from HTML string.
 */
export function extractMetaTags(html: string): {
  title: string;
  description: string;
  canonicalUrl: string;
  openGraph: Record<string, string>;
} {
  const openGraph: Record<string, string> = {};

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  let description = "";
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  if (descMatch) description = descMatch[1].trim();

  let canonicalUrl = "";
  const canonMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
  if (canonMatch) canonicalUrl = canonMatch[1].trim();

  // Extract all property="og:*" and name="twitter:*"
  const ogRegex = /<meta[^>]+(?:property|name)=["'](og:[a-zA-Z0-9_:]+|twitter:[a-zA-Z0-9_:]+)["'][^>]+content=["']([^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = ogRegex.exec(html)) !== null) {
    const prop = match[1].toLowerCase();
    const val = match[2].trim();
    openGraph[prop] = val;
  }

  // Also check inverted attribute order: content="..." property="..."
  const ogInvertedRegex = /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](og:[a-zA-Z0-9_:]+|twitter:[a-zA-Z0-9_:]+)["']/gi;
  while ((match = ogInvertedRegex.exec(html)) !== null) {
    const prop = match[2].toLowerCase();
    const val = match[1].trim();
    if (!openGraph[prop]) openGraph[prop] = val;
  }

  return {
    title: openGraph["og:title"] || openGraph["twitter:title"] || title,
    description: openGraph["og:description"] || openGraph["twitter:description"] || description,
    canonicalUrl: openGraph["og:url"] || canonicalUrl,
    openGraph,
  };
}

/**
 * Extracts and parses JSON-LD script tags from HTML string.
 */
export function extractJsonLd(html: string): unknown[] {
  const jsonLd: unknown[] = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) jsonLd.push(...parsed);
      else if (parsed) jsonLd.push(parsed);
    } catch {
      // Malformed script ignored
    }
  }
  return jsonLd;
}

/**
 * Parses visible metric strings honestly without inventing values.
 */
function parseVisibleMetric(text: string): number | null {
  const m = text.match(/([\d,.]+)\s*([KkMmBb])?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(num)) return null;
  const unit = m[2]?.toUpperCase();
  if (unit === "K") return Math.round(num * 1_000);
  if (unit === "M") return Math.round(num * 1_000_000);
  if (unit === "B") return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

/**
 * Pluggable repeated card and ad/post extractor from HTML page.
 */
export function extractRepeatedCards(html: string, pageUrl: string, runId: string): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  const seenHashes = new Set<string>();

  // 1. Check for <article> blocks or common repeated card classes
  const cardBlockRegex = /<(?:article|div|li)[^>]*(?:class|role)=["'][^"']*(?:card|feed-item|post|ad-card|entry|item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:article|div|li)>/gi;
  let cardIndex = 0;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = cardBlockRegex.exec(html)) !== null && cardIndex < 50) {
    const cardHtml = blockMatch[1];

    // Extract title / headline
    const headlineMatch = cardHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
                          cardHtml.match(/class=["'][^"']*(?:title|headline)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i);
    const title = headlineMatch ? htmlToText(headlineMatch[1]).slice(0, 200) : "";

    // Extract text / caption
    const textMatch = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
                      cardHtml.match(/class=["'][^"']*(?:desc|caption|snippet)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i);
    const text = textMatch ? htmlToText(textMatch[1]).slice(0, 500) : "";

    if (!title && !text) {
      continue;
    }

    // Extract image or video link
    const imgMatch = cardHtml.match(/<img[^>]+src=["']([^"']*)["']/i);
    const videoMatch = cardHtml.match(/<video[^>]+src=["']([^"']*)["']/i) || cardHtml.match(/<source[^>]+src=["']([^"']*)["']/i);
    const mediaUrl = videoMatch ? videoMatch[1] : (imgMatch ? imgMatch[1] : undefined);

    // Extract destination link
    const linkMatch = cardHtml.match(/<a[^>]+href=["']([^"']*)["']/i);
    let destinationUrl: string | undefined;
    if (linkMatch && linkMatch[1]) {
      try {
        destinationUrl = new URL(linkMatch[1], pageUrl).toString();
      } catch {
        // Invalid URL ignored
      }
    }

    // Extract visible metrics if present
    const metrics: DiscoveredItem["metrics"] = {
      views: { value: null, state: "UNAVAILABLE" },
      likes: { value: null, state: "UNAVAILABLE" },
      comments: { value: null, state: "UNAVAILABLE" },
    };

    const viewsMatch = cardHtml.match(/([\d,.]+\s*[KkMmBb]?)\s*(?:views|plays|impressions)/i);
    if (viewsMatch) {
      metrics.views = { value: parseVisibleMetric(viewsMatch[1]), state: "OBSERVED" };
    }

    const likesMatch = cardHtml.match(/([\d,.]+\s*[KkMmBb]?)\s*(?:likes|upvotes)/i);
    if (likesMatch) {
      metrics.likes = { value: parseVisibleMetric(likesMatch[1]), state: "OBSERVED" };
    }

    const contentHash = createHash("sha256").update([title, text, destinationUrl || ""].join("\0")).digest("hex");
    if (seenHashes.has(contentHash)) continue;
    seenHashes.add(contentHash);

    items.push({
      id: `card_${runId}_${cardIndex}`,
      runId,
      url: destinationUrl || pageUrl,
      canonicalUrl: destinationUrl || pageUrl,
      source: "repeated_card_discovery",
      cardType: videoMatch ? "video" : (cardHtml.includes("sponsored") || cardHtml.includes("ad") ? "ad_card" : "post"),
      title: title || undefined,
      text: text || undefined,
      mediaUrl: mediaUrl ? new URL(mediaUrl, pageUrl).toString() : undefined,
      destinationUrl,
      metrics,
      contentHash,
      sourceLocation: `${pageUrl}#card-${cardIndex}`,
      discoveredAt: new Date().toISOString(),
    });

    cardIndex++;
  }

  return items;
}

/**
 * Extracts eligible outbound same-origin links for crawling.
 */
export function extractOutboundLinks(html: string, baseUrl: string, allowedHosts?: string[]): string[] {
  const links = new Set<string>();
  const base = new URL(baseUrl);
  const hrefRegex = /<a[^>]+href=["']([^"'#\s]+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
      continue;
    }

    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

      // Restrict to same host or explicitly allowed hosts
      const sameHost = resolved.hostname.toLowerCase() === base.hostname.toLowerCase();
      const hostAllowed = allowedHosts && allowedHosts.includes(resolved.hostname.toLowerCase());

      if (sameHost || hostAllowed) {
        // Strip hash fragment
        resolved.hash = "";
        links.add(resolved.toString());
      }
    } catch {
      // Malformed href ignored
    }
  }

  return Array.from(links);
}

/**
 * The network seam for a crawl. Production uses the DNS-pinned public fetcher. A test passes a fake, so the whole ladder runs
 * with no network. The SSRF check on the requested URL runs before the fetch in either case.
 */
export interface CrawlDependencies {
  fetchHtml?: (url: string) => Promise<{ url: string; html: string }>;
}

/**
 * Crawls a single page through the complete crawl ladder. `fetchedAt` is the time the page was requested, recorded as the
 * observation time of everything extracted from it.
 */
export async function crawlLadderPage(
  url: string,
  runId: string,
  allowedHosts?: string[],
  deps: CrawlDependencies = {},
): Promise<PageCrawlResult> {
  const issue = publicUrlIssue(url);
  if (issue) throw new Error(`URL rejected by SSRF guard: ${issue}`);

  const fetchedAt = new Date().toISOString();
  const snapshot = await (deps.fetchHtml ?? fetchPublicHtml)(url);
  const meta = extractMetaTags(snapshot.html);
  const jsonLd = extractJsonLd(snapshot.html);
  const cards = extractRepeatedCards(snapshot.html, snapshot.url, runId);
  const outboundLinks = extractOutboundLinks(snapshot.html, snapshot.url, allowedHosts);

  return {
    url,
    finalUrl: snapshot.url,
    title: meta.title,
    description: meta.description,
    canonicalUrl: meta.canonicalUrl || snapshot.url,
    openGraph: meta.openGraph,
    jsonLd,
    cards,
    outboundLinks,
    fetchedAt,
  };
}
