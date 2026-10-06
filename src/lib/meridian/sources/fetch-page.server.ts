import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { ipIsBlocked, publicUrlIssue } from "./public-url.ts";

const MAX_BYTES = 200_000;
const MAX_HOPS = 2;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
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
  const response = await requestPage(url, pinnedLookup);
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

function requestPage(url: URL, pinnedLookup: NonNullable<RequestOptions["lookup"]>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        headers: { accept: "text/html,text/plain;q=0.9" },
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
