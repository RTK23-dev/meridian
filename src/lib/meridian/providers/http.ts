import { isCapabilityDisabledError } from "./capability.ts";

export type TransportRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string | FormData | Uint8Array;
};

export type TransportResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Provider response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Provider response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function liveTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Provider request timed out after 30 seconds.")), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body as BodyInit | undefined,
        signal: controller.signal,
        redirect: "error",
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const body = await readBoundedBody(response, DEFAULT_RESPONSE_LIMIT_BYTES);
      return { status: response.status, body, headers };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type HttpResult = {
  ok: boolean;
  status: number;
  json: unknown;
  error: string;
  attempts: number;
};

function retryAfterMs(headers: Record<string, string>): number {
  const raw = headers["retry-after"] ?? "";
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, 2000);
}

const SECRET_QUERY_VALUE = /\b(app_secret|client_secret|access_token|refresh_token|secret|token)=[^&\s"'<>]*/gi;

/**
 * Removes credentials from text that may reach an error message, a result or a log: the exact request URL
 * (its query string can carry a secret), each caller-named secret in raw and URL-encoded form, and any
 * secret-looking query parameter left over.
 */
export function redactProviderText(text: string, options: { url?: string; secrets?: readonly string[] } = {}): string {
  let out = text;
  if (options.url) out = out.split(options.url).join("[provider request]");
  for (const secret of options.secrets ?? []) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join("[redacted]");
  }
  return out.replace(SECRET_QUERY_VALUE, "$1=[redacted]");
}

/** GET and PUT repeat the same request. A POST may create or charge something, so it is repeated only when the caller says it is idempotent. */
const REPEATABLE_METHODS = new Set<TransportRequest["method"]>(["GET", "PUT"]);

/**
 * Retries 429 and 5xx, and a request that failed before any answer, when the request can be repeated safely. A 4xx other than 429 is the
 * provider's answer and is not retried. A request that cannot be repeated is sent once: its outcome may be unknown, and a repeat could
 * bill or write twice. A disabled capability sent nothing, so it returns at once.
 */
export async function sendWithRetry(
  transport: Transport,
  request: TransportRequest,
  options?: { attempts?: number; sleep?: (ms: number) => Promise<void>; redact?: readonly string[]; idempotent?: boolean },
): Promise<HttpResult> {
  const repeatable = options?.idempotent === true || REPEATABLE_METHODS.has(request.method);
  const attempts = repeatable ? (options?.attempts ?? 3) : 1;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Error text is built from transport and provider messages, which can echo the request URL or its query.
  const scrub = (text: string) => redactProviderText(text, { url: request.url, secrets: options?.redact });
  let last: HttpResult = { ok: false, status: 0, json: null, error: "No request was sent.", attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: TransportResponse;
    try {
      response = await transport(request);
    } catch (error) {
      if (isCapabilityDisabledError(error)) return { ok: false, status: 0, json: null, error: error.message, attempts: attempt };
      last = {
        ok: false,
        status: 0,
        json: null,
        error: scrub(error instanceof Error ? error.message : "The provider request failed."),
        attempts: attempt,
      };
      if (attempt < attempts) await sleep(200 * attempt);
      continue;
    }
    let json: unknown = null;
    try {
      json = response.body ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    const retry = response.status === 429 || response.status >= 500;
    last = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json,
      error: retry ? `Provider returned ${response.status}.` : response.status >= 400 ? scrub(providerMessage(json) || `Provider returned ${response.status}.`) : "",
      attempts: attempt,
    };
    if (!retry) return last;
    if (attempt < attempts) await sleep(retryAfterMs(response.headers));
  }
  return last;
}

function providerMessage(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const record = json as { error?: { message?: string }; message?: string };
  return record.error?.message || record.message || "";
}

export async function collectPages(
  transport: Transport,
  start: TransportRequest,
  nextUrl: (json: unknown) => string | null,
  maxPages = 5,
): Promise<{ pages: unknown[]; error: string }> {
  const pages: unknown[] = [];
  let request = start;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await sendWithRetry(transport, request);
    if (!result.ok) return { pages, error: result.error || "A page failed." };
    pages.push(result.json);
    const next = nextUrl(result.json);
    if (!next) break;
    request = { ...request, method: "GET", url: next, body: undefined };
  }
  return { pages, error: "" };
}
