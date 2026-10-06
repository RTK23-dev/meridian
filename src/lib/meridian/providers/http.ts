export type TransportRequest = {
  method: "GET" | "POST";
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

export function liveTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit | undefined,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, body: await response.text(), headers };
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

/** Retries 429 and 5xx. A 4xx other than 429 is the provider's answer and is not retried. */
export async function sendWithRetry(
  transport: Transport,
  request: TransportRequest,
  options?: { attempts?: number; sleep?: (ms: number) => Promise<void> },
): Promise<HttpResult> {
  const attempts = options?.attempts ?? 3;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last: HttpResult = { ok: false, status: 0, json: null, error: "No request was sent.", attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: TransportResponse;
    try {
      response = await transport(request);
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        json: null,
        error: error instanceof Error ? error.message : "The provider request failed.",
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
      error: retry ? `Provider returned ${response.status}.` : response.status >= 400 ? providerMessage(json) || `Provider returned ${response.status}.` : "",
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
