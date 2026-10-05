import { lookup } from "node:dns/promises";
import { ipIsBlocked, publicUrlIssue } from "@/lib/meridian/sources/public-url";

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

async function assertResolved(hostname: string): Promise<void> {
  let records: { address: string }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve that host.");
  }
  if (records.length === 0) throw new Error("Could not resolve that host.");
  for (const record of records) {
    if (ipIsBlocked(record.address)) throw new Error("That host does not resolve to a public address.");
  }
}

export async function fetchPublicText(rawUrl: string, hops = 0): Promise<{ url: string; text: string }> {
  const issue = publicUrlIssue(rawUrl);
  if (issue) throw new Error(issue);
  const url = new URL(rawUrl);
  await assertResolved(url.hostname);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: { accept: "text/html,text/plain;q=0.9" },
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || hops >= MAX_HOPS) throw new Error("The page redirected too many times.");
    return fetchPublicText(new URL(location, url).toString(), hops + 1);
  }
  if (!response.ok) throw new Error(`The page returned ${response.status}.`);
  const type = response.headers.get("content-type") ?? "";
  if (type && !type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
    throw new Error("Only HTML or plain text pages can be stored.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The page had no body.");
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
