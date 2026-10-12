/**
 * Client for Meridian's sourcing sidecar (sidecar/sourcing/server.py). The sidecar parses a page that Meridian has already fetched
 * under its robots and bot-check policy. It never fetches a URL, so this client only sends HTML that passed those checks.
 *
 * The sidecar is used only when MERIDIAN_SOURCING_SIDECAR_URL (a local http address) and MERIDIAN_SIDECAR_TOKEN (at least 24
 * characters) are both set. If it is off, slow or fails, the page is read with the built-in text extraction, and the result says
 * which one ran. The sidecar's error is not shown, because it can carry part of the page.
 */

export type SidecarConfig = { url: string; token: string };
export type PageExtraction = { text: string; extractor: "scrapling" | "builtin" };

const TIMEOUT_MS = 5_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MIN_TOKEN_LENGTH = 24;

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
    try {
      const response = await fetchImpl(`${config.url}/parse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sidecar-token": config.token },
        body: JSON.stringify({ html, baseUrl }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      if (response.ok) {
        const body = (await response.json()) as { text?: unknown };
        if (typeof body.text === "string") return { text: body.text, extractor: "scrapling" };
      }
    } catch {
      // Fall through to the built-in extraction. The error is dropped on purpose, because it can carry part of the page.
    }
  }
  return { text: fallback(html), extractor: "builtin" };
}
