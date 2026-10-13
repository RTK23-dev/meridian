/**
 * Whether a URL is an https link on a verified domain. This file has no imports, so a publisher can check a link without loading the
 * signing code in media-link.ts, which uses Node's crypto module and must stay out of the browser bundle.
 */
/** True when the URL's host is a verified domain or a subdomain of one. TikTok covers subdomains of a verified domain. */
export function hostIsVerified(url: string, verifiedDomains: readonly string[]): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return verifiedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

