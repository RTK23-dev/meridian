/**
 * Client for Meridian's sourcing sidecar (sidecar/sourcing/server.py). The sidecar parses pages and feeds that Meridian has already
 * fetched under its robots and bot-check policy, and it reads Agent Reach's public V2EX channel. It never fetches a URL it was
 * given, so this client only sends content that passed those checks.
 *
 * The sidecar is used only when MERIDIAN_SOURCING_SIDECAR_URL (a local http address) and MERIDIAN_SIDECAR_TOKEN (at least 24
 * characters) are both set. Each call returns null when the sidecar is off, slow or failing, so the caller can fall back or report
 * it. The sidecar's error is not returned, because it can carry part of the page.
 */

export type SidecarConfig = { url: string; token: string };
export type PageExtraction = { text: string; extractor: "scrapling" | "builtin" };
export type SidecarFeedItem = { title: string; link: string; published: string; summary: string };
export type SidecarFeed = { feedTitle: string; items: SidecarFeedItem[] };
export type SidecarTopic = { title: string; url: string; replies: number };

const TIMEOUT_MS = 5_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MIN_TOKEN_LENGTH = 24;
const MAX_LIMIT = 50;

export function sidecarConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig | null {
  const rawUrl = env.MERIDIAN_SOURCING_SIDECAR_URL?.trim();
  const token = env.MERIDIAN_SIDECAR_TOKEN?.trim() ?? "";
  if (!rawUrl || token.length < MIN_TOKEN_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !LOCAL_HOSTS.has(parsed.hostname)) return null;
  return { url: parsed.origin, token };
}

/** One JSON POST to the sidecar. Returns null on any failure, and never follows a redirect. */
async function postToSidecar(
  config: SidecarConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  try {
    const response = await fetchImpl(`${config.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sidecar-token": config.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The page's readable text. The sidecar's parser is used when it is configured and answers in time with a text field;
 * otherwise `fallback` (the built-in extraction) reads the same HTML.
 */
export async function extractPageText(
  html: string,
  baseUrl: string,
  fallback: (html: string) => string,
  config: SidecarConfig | null = sidecarConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<PageExtraction> {
  if (config) {
    const body = (await postToSidecar(config, "/parse", { html, baseUrl }, fetchImpl)) as { text?: unknown } | null;
    if (body && typeof body.text === "string") return { text: body.text, extractor: "scrapling" };
  }
  return { text: fallback(html), extractor: "builtin" };
}

function clamp(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** A feed's items, parsed by Agent Reach's RSS reader inside the sidecar. Null when the sidecar cannot read the feed. */
export async function parseFeedWithSidecar(
  config: SidecarConfig,
  feed: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SidecarFeed | null> {
  const body = (await postToSidecar(config, "/feed", { feed, limit: clamp(limit) }, fetchImpl)) as { feedTitle?: unknown; items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) return null;
  const items = body.items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: text(item.title, 300),
      link: text(item.link, 2000),
      published: text(item.published, 100),
      summary: text(item.summary, 1000),
    }))
    .filter((item) => item.link.length > 0);
  return { feedTitle: text(body.feedTitle, 300), items };
}

/** V2EX's hot topics, or one node's topics when a node name is given. Null when the sidecar cannot answer. */
export async function v2exTopicsWithSidecar(
  config: SidecarConfig,
  node: string | null,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SidecarTopic[] | null> {
  const path = node ? "/v2ex/node" : "/v2ex/hot";
  const payload: Record<string, unknown> = node ? { node, limit: clamp(limit) } : { limit: clamp(limit) };
  const body = (await postToSidecar(config, path, payload, fetchImpl)) as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) return null;
  return body.items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: text(item.title, 300),
      url: text(item.url, 2000),
      replies: typeof item.replies === "number" && Number.isFinite(item.replies) ? item.replies : 0,
    }))
    .filter((topic) => topic.url.length > 0);
}
