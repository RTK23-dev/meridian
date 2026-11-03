/**
 * Which sites may show Meridian inside a frame. The server sends `Content-Security-Policy: frame-ancestors <value>` on every response.
 *
 * `MERIDIAN_FRAME_ANCESTORS` is a comma-separated list of https origins, for example `https://victor.ceo,https://www.victor.ceo`.
 * Unset, only Meridian's own pages may frame it (`'self'`). Any entry that is not a plain https origin makes the whole value fall
 * back to `'self'`: a mistyped entry must never widen the policy. Pure, so the Vite config and the deployment check share it.
 *
 * @param {string | undefined} raw
 * @returns {{ value: string, problems: string[] }} the `frame-ancestors` source list, and one message per bad entry.
 */
export function frameAncestorsPolicy(raw) {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return { value: "'self'", problems: [] };

  const sources = [];
  const problems = [];
  for (const entry of entries) {
    if (entry === "'self'") {
      sources.push(entry);
      continue;
    }
    let url;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`"${entry}" is not a URL`);
      continue;
    }
    // A wildcard host (https://*.example) is refused: each embedding site is named exactly.
    const plain = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password && !url.hostname.includes("*");
    if (url.protocol !== "https:" || !plain) {
      problems.push(`"${entry}" is not a plain https origin`);
      continue;
    }
    sources.push(url.origin);
  }

  if (problems.length > 0) return { value: "'self'", problems };
  return { value: [...new Set(sources)].join(" "), problems: [] };
}
