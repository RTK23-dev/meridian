// Recorded responses for the E1 dry run. The replay transport is the injected HttpTransport of the gateway, so the dry run
// goes through the same routing, authentication and render adapter as a live run, and nothing reaches the network.
//
// The replay is strict. Each request must match the next recorded exchange by method and URL, carry the headers the exchange
// names, and send the key only where the exchange says it may go. Any drift (an extra request, a different order, a key on a
// signed URL) throws and fails the dry run. The recording is constructed, not captured (see provenance in the fixture).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/engine/gateway/index.ts";

/** The placeholder the dry run gives the HeyGen credential. It is not a key, and it must appear only on HeyGen requests. */
export const DRY_RUN_KEY = "dry-run-placeholder-not-a-key";

export type RecordedExchange = {
  /** What the step is, for error messages (for example "upload start"). */
  label: string;
  method: "GET" | "POST" | "PUT";
  /** Exact URL. */
  url: string;
  /** "heygen": the request carries the HeyGen key. "none": it must not carry any key (signed URLs and the media functions). */
  auth: "heygen" | "none";
  /** Header names the request must carry (matched without regard to case). */
  requireHeaders?: string[];
  /** A substring the request body must contain. */
  requestBodyIncludes?: string;
  status: number;
  /** A JSON response body. */
  json?: unknown;
  /** A binary response body, base64. */
  bodyBase64?: string;
};

export type Recording = {
  provenance: string;
  mediaFunctionsBaseUrl: string;
  /** The stand-in bytes of each existing asset, by URI. */
  assets: Record<string, Uint8Array>;
  /** One render, in the order the render adapter makes its calls. The dry run replays it once per render. */
  render: RecordedExchange[];
  /** The media functions' integrity limit for the dry run (the platform size limit is not set in config). */
  dryRunPlatformMaxBytes: number;
};

type RawRecording = {
  provenance: string;
  mediaFunctionsBaseUrl: string;
  assets: Record<string, string>;
  render: RecordedExchange[];
  dryRunPlatformMaxBytes: number;
};

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/e1-recorded.json", import.meta.url));

/** Loads the recorded fixture. The bytes are decoded here, so a bad fixture fails at load time. */
export function loadRecording(path: string = FIXTURE_PATH): Recording {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawRecording;
  if (typeof raw.provenance !== "string" || raw.provenance.length === 0) {
    throw new Error("the recorded fixture must say where it came from");
  }
  const assets: Record<string, Uint8Array> = {};
  for (const [uri, base64] of Object.entries(raw.assets)) {
    assets[uri] = new Uint8Array(Buffer.from(base64, "base64"));
  }
  return {
    provenance: raw.provenance,
    mediaFunctionsBaseUrl: raw.mediaFunctionsBaseUrl,
    assets,
    render: raw.render,
    dryRunPlatformMaxBytes: raw.dryRunPlatformMaxBytes,
  };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function bodyText(body: string | Uint8Array | undefined): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function responseFor(exchange: RecordedExchange): HttpResponse {
  if (exchange.json !== undefined) {
    return {
      status: exchange.status,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(exchange.json)),
    };
  }
  if (exchange.bodyBase64 !== undefined) {
    return {
      status: exchange.status,
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(Buffer.from(exchange.bodyBase64, "base64")),
    };
  }
  return { status: exchange.status, headers: {}, body: new Uint8Array(0) };
}

function checkRequest(index: number, exchange: RecordedExchange, request: HttpRequest): void {
  const where = `dry run: recorded step ${index} (${exchange.label})`;
  if (request.method !== exchange.method || request.url !== exchange.url) {
    throw new Error(`${where} expected ${exchange.method} ${exchange.url}, but the engine sent ${request.method} ${request.url}`);
  }
  const key = headerValue(request.headers, "x-api-key");
  if (exchange.auth === "heygen") {
    if (key !== DRY_RUN_KEY) throw new Error(`${where} must carry the HeyGen credential`);
    if (headerValue(request.headers, "X-HeyGen-Client-Source") === undefined) {
      throw new Error(`${where} must name its client source`);
    }
  } else if (key !== undefined) {
    throw new Error(`${where} must not carry a credential: the key may only go to the provider's own API`);
  }
  for (const name of exchange.requireHeaders ?? []) {
    if (headerValue(request.headers, name) === undefined) throw new Error(`${where} is missing the header ${name}`);
  }
  if (exchange.requestBodyIncludes !== undefined && !bodyText(request.body).includes(exchange.requestBodyIncludes)) {
    throw new Error(`${where} did not send the recorded body (the bytes it was asked to check are not the rendered video)`);
  }
}

export type Replay = {
  transport: HttpTransport;
  /** Throws unless every recorded step was used, in order. Call it after the run. */
  finish(): void;
  /** Steps still to be used. */
  remaining(): number;
};

/** A transport that answers from the recorded steps, in order, and refuses any request that does not match the next one. */
export function createReplay(steps: RecordedExchange[]): Replay {
  let next = 0;
  const transport: HttpTransport = async (request) => {
    const exchange = steps[next];
    if (!exchange) {
      throw new Error(`dry run: the engine sent ${request.method} ${request.url}, but every recorded step was already used`);
    }
    checkRequest(next, exchange, request);
    next += 1;
    return responseFor(exchange);
  };
  return {
    transport,
    finish() {
      if (next !== steps.length) {
        throw new Error(`dry run: ${steps.length - next} recorded step(s) were not used; the engine made fewer calls than recorded`);
      }
    },
    remaining() {
      return steps.length - next;
    },
  };
}
