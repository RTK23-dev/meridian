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
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpv4(normalized)) {
    const [a, b, c] = normalized.split(".").map(Number) as [number, number, number];
    return ipv4Blocked(a, b, c);
  }
  const parsed = parseIpv6(normalized);
  if (!parsed) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = parsed as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embeddedIpv4Blocked(g6, g7);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return embeddedIpv4Blocked(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true;
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedIpv4Blocked(g6, g7);
    return true;
  }
  if (g0 === 0x2002) return embeddedIpv4Blocked(g1, g2);
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return true;
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if ((g0 & 0xe000) !== 0x2000) return true;
  return false;
}

function parseIpv6(raw: string): number[] | null {
  if (raw.includes("%")) return null;
  let text = raw;
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    if (!isIpv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, text.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsFor = (part: string) => part === "" ? [] : part.split(":");
  const head = groupsFor(halves[0] ?? "");
  const rest = halves.length === 2 ? groupsFor(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = halves.length === 2 ? [...head, ...Array<string>(missing).fill("0"), ...rest] : head;
  if (parts.length !== 8) return null;
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

function ipv4Blocked(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function embeddedIpv4Blocked(high: number, low: number): boolean {
  return ipv4Blocked(high >> 8, high & 0xff, low >> 8);
}
