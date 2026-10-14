// The HTTP side of the media functions. The transport is injected, so tests replay recorded responses and production
// passes fetchTransport(). Every response is untrusted: a 200 must match the result schema, and every failure becomes a
// typed EngineError (retryable for rate limits, server errors, timeouts and unreachable hosts).

import { z, type ZodType } from "zod";
import { EngineError, ENGINE_ERROR_KINDS, type EngineErrorKind } from "../contracts/errors.ts";

export type MediaTransportRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type MediaTransportResponse = { status: number; body: string };

/**
 * Sends one request and returns the status and body. It may throw when the host is unreachable or the timeout passes;
 * the client turns that into a retryable provider error.
 */
export type MediaTransport = (request: MediaTransportRequest) => Promise<MediaTransportResponse>;

/** The transport for production: fetch with a timeout. Credentials, if any, come from the caller's resolver. */
export function fetchTransport(fetchImpl: typeof fetch = fetch): MediaTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

export type WirePost = <Body>(
  path: string,
  body: unknown,
  schema: ZodType<Body>,
  timeoutMs: number,
) => Promise<Body>;

const STAGE = "media.client";
const MESSAGE_CHARS = 300;

const errorBodySchema = z.object({
  error: z.object({
    kind: z.string().optional(),
    retryable: z.boolean().optional(),
    message: z.string().optional(),
  }),
});

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}

function errorFromResponse(path: string, status: number, payload: unknown): EngineError {
  const parsed = errorBodySchema.safeParse(payload);
  const body = parsed.success ? parsed.data.error : undefined;
  const kind: EngineErrorKind =
    body?.kind !== undefined && (ENGINE_ERROR_KINDS as readonly string[]).includes(body.kind)
      ? (body.kind as EngineErrorKind)
      : "provider";
  const retryable = typeof body?.retryable === "boolean" ? body.retryable : retryableStatus(status);
  const message = (body?.message ?? `HTTP ${status}`).slice(0, MESSAGE_CHARS);
  return new EngineError(kind, `media function ${path} failed (HTTP ${status}): ${message}`, {
    retryable,
    stage: STAGE,
  });
}

/**
 * POSTs a JSON body to one media function and validates the answer against the schema. A non-200 answer is turned into
 * the typed error the function reported, or a status-based one when the body is not in the expected shape.
 */
export function wirePost(baseUrl: string, transport: MediaTransport): WirePost {
  return async <Body>(
    path: string,
    body: unknown,
    schema: ZodType<Body>,
    timeoutMs: number,
  ): Promise<Body> => {
    let response: MediaTransportResponse;
    try {
      response = await transport({
        url: `${baseUrl}${path}`,
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof EngineError) {
        throw error;
      }
      throw new EngineError(
        "provider",
        `media function ${path} did not answer: ${describe(error)}`,
        {
          retryable: true,
          stage: STAGE,
          cause: error,
        },
      );
    }

    let payload: unknown;
    let isJson = true;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      isJson = false;
    }

    if (response.status !== 200) {
      if (!isJson) {
        throw new EngineError(
          "provider",
          `media function ${path} failed (HTTP ${response.status}) without a JSON body`,
          {
            retryable: retryableStatus(response.status),
            stage: STAGE,
          },
        );
      }
      throw errorFromResponse(path, response.status, payload);
    }
    if (!isJson) {
      throw new EngineError("provider", `media function ${path} returned a body that is not JSON`, {
        stage: STAGE,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join(".") || "result"}: ${issue.message}`)
        .join("; ");
      throw new EngineError(
        "provider",
        `media function ${path} returned an invalid result: ${detail}`,
        { stage: STAGE },
      );
    }
    return parsed.data;
  };
}
