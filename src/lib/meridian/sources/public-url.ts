/** Syntax and hostname policy. DNS resolution is a separate step in the fetcher. */

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  return value.includes(":");
}

export function publicUrlIssue(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That is not a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https URLs can be read.";
  if (url.username || url.password) return "URLs with embedded credentials are blocked.";
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host) return "The URL has no host.";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "Local hostnames are blocked.";
  }
  if (host === "metadata.google.internal" || host === "metadata.google") {
    return "Metadata hosts are blocked.";
  }
  if ((isIpv4(host) || isIpv6(host)) && ipIsBlocked(host)) return "That address is not a public host.";
  return null;
}

export function ipIsBlocked(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "0.0.0.0") return true;
  if (isIpv4(normalized)) {
    const [a, b] = normalized.split(".").map((part) => Number(part));
    if (a === undefined || b === undefined) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIpv6(normalized)) {
    if (normalized.startsWith("fe80")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    return false;
  }
  return true;
}
