import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { ipIsBlocked, publicUrlIssue } from "./public-url.ts";

const MAX_BYTES = 200_000;
const MAX_MEDIA_BYTES = 80_000_000;
const MAX_HOPS = 2;

function codePointText(code: number): string {
  if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
  return String.fromCodePoint(code);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d{1,8});/g, (_match, code: string) => codePointText(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, code: string) => codePointText(parseInt(code, 16)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    // Decode ampersand last: nested encodings are decoded only once.
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

type LookupAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<LookupAddress[]>;
type LookupOptions = { all?: boolean; family?: number };
type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Resolve once, validate every answer, and pin Node's connection lookup to those answers. */
export async function resolveAndPinHost(
  hostname: string,
  resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<NonNullable<RequestOptions["lookup"]>> {
  let records: LookupAddress[];
  try {
    records = await resolver(hostname);
  } catch {
    throw new Error("Could not resolve that host.");
  }
  if (records.length === 0) throw new Error("Could not resolve that host.");
  for (const record of records) {
    if (ipIsBlocked(record.address)) throw new Error("That host does not resolve to a public address.");
  }

  const pinnedLookup = (
    (_requestedHostname: string, rawOptions: number | LookupOptions, callback: LookupCallback) => {
      const options = typeof rawOptions === "number" ? { family: rawOptions } : rawOptions;
      const eligible = records.filter((record) => !options.family || record.family === options.family);
      if (eligible.length === 0) {
        const error = Object.assign(new Error("No validated address matches the requested family."), { code: "ENOTFOUND" });
        callback(error, "");
        return;
      }
      if (options.all) callback(null, eligible);
      else callback(null, eligible[0]!.address, eligible[0]!.family);
    }
  ) as NonNullable<RequestOptions["lookup"]>;
  return pinnedLookup;
}

export async function fetchPublicText(rawUrl: string, hops = 0): Promise<{ url: string; text: string }> {
  const issue = publicUrlIssue(rawUrl);
  if (issue) throw new Error(issue);
  const url = new URL(rawUrl);
  const pinnedLookup = await resolveAndPinHost(url.hostname);
  const response = await requestPage(url, pinnedLookup, "text/html,text/plain;q=0.9");
  const statusCode = response.statusCode;
  if (statusCode != null && statusCode >= 300 && statusCode < 400) {
    const location = response.headers.location;
    const redirect = Array.isArray(location) ? location[0] : location;
    if (!redirect || hops >= MAX_HOPS) throw new Error("The page redirected too many times.");
    return fetchPublicText(new URL(redirect, url).toString(), hops + 1);
  }
  if (statusCode == null || statusCode < 200 || statusCode >= 300) {
    throw new Error(`The page returned ${statusCode ?? "an invalid status"}.`);
  }
  const contentType = response.headers["content-type"];
  const type = Array.isArray(contentType) ? contentType.join(",") : contentType ?? "";
  if (type && !type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
    throw new Error("Only HTML or plain text pages can be stored.");
  }
  const reader = Readable.toWeb(response).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < MAX_BYTES) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    chunks.push(step.value);
  }
  await reader.cancel().catch(() => undefined);
  const html = new TextDecoder().decode(concat(chunks)).slice(0, MAX_BYTES);
  const text = htmlToText(html);
  if (text.length < 40) throw new Error("The page did not contain enough text to store.");
  return { url: url.toString(), text };
}

/** Fetches bounded public video bytes using the same DNS-pinned connection as page collection. */
export async function fetchPublicMedia(rawUrl: string, hops = 0, maxBytes = MAX_MEDIA_BYTES): Promise<{ url: string; mimeType: string; bytes: Uint8Array }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES) throw new Error("The media byte limit is invalid.");
  const issue = publicUrlIssue(rawUrl);
  if (issue) throw new Error(issue);
  const url = new URL(rawUrl);
  const pinnedLookup = await resolveAndPinHost(url.hostname);
  const response = await requestPage(url, pinnedLookup, "video/*,application/octet-stream;q=0.9", 120_000);
  const statusCode = response.statusCode;
  if (statusCode != null && statusCode >= 300 && statusCode < 400) {
    const location = response.headers.location;
    const redirect = Array.isArray(location) ? location[0] : location;
    if (!redirect || hops >= MAX_HOPS) throw new Error("The media redirected too many times.");
    return fetchPublicMedia(new URL(redirect, url).toString(), hops + 1, maxBytes);
  }
  if (statusCode == null || statusCode < 200 || statusCode >= 300) throw new Error(`The media returned ${statusCode ?? "an invalid status"}.`);
  const contentType = response.headers["content-type"];
  const mimeType = (Array.isArray(contentType) ? contentType[0] : contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("video/")) throw new Error("The source did not return a video file.");
  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`The source video is larger than the ${Math.ceil(maxBytes / 1_000_000)} MB research limit.`);
  const reader = Readable.toWeb(response).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received <= maxBytes) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The source video is larger than the ${Math.ceil(maxBytes / 1_000_000)} MB research limit.`);
    }
    chunks.push(step.value);
  }
  if (received === 0) throw new Error("The source video is empty.");
  return { url: url.toString(), mimeType, bytes: concat(chunks) };
}

/** Reads a small public HTML snapshot while preserving the same DNS and redirect checks. */
export async function fetchPublicHtml(rawUrl: string, hops = 0): Promise<{ url: string; html: string }> {
  const issue = publicUrlIssue(rawUrl);
  if (issue) throw new Error(issue);
  const url = new URL(rawUrl);
  const pinnedLookup = await resolveAndPinHost(url.hostname);
  const response = await requestPage(url, pinnedLookup, "text/html;q=0.9");
  const statusCode = response.statusCode;
  if (statusCode != null && statusCode >= 300 && statusCode < 400) {
    const location = response.headers.location;
    const redirect = Array.isArray(location) ? location[0] : location;
    if (!redirect || hops >= MAX_HOPS) throw new Error("The snapshot redirected too many times.");
    return fetchPublicHtml(new URL(redirect, url).toString(), hops + 1);
  }
  if (statusCode == null || statusCode < 200 || statusCode >= 300) throw new Error(`The snapshot returned ${statusCode ?? "an invalid status"}.`);
  const contentType = response.headers["content-type"];
  const type = Array.isArray(contentType) ? contentType.join(",") : contentType ?? "";
  if (type && !type.includes("text/html") && !type.includes("application/xhtml")) throw new Error("The ad snapshot did not return HTML.");
  const reader = Readable.toWeb(response).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < MAX_BYTES) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    chunks.push(step.value);
  }
  await reader.cancel().catch(() => undefined);
  return { url: url.toString(), html: new TextDecoder().decode(concat(chunks)).slice(0, MAX_BYTES) };
}

function requestPage(url: URL, pinnedLookup: NonNullable<RequestOptions["lookup"]>, accept: string, timeoutMs = 8_000): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept },
        lookup: pinnedLookup,
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
