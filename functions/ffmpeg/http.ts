// The serverless entry point: a Web-standard Request in, a Response out. Routes: POST /probe, /frames, /loudness, /cuts, /timeline
// and GET /health (tool versions). Errors are typed: the body carries kind, retryable and message, and the status
// follows from the kind. Unexpected errors return a generic message, never a stack trace.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import * as cuts from "./cuts.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import * as frames from "./frames.ts";
import * as loudness from "./loudness.ts";
import * as probe from "./probe.ts";
import * as timeline from "./timeline.ts";
import type { UrlPolicy } from "./source.ts";
import {
  sourceFromWire,
  wireCutsRequestSchema,
  wireTimelineRequestSchema,
  wireFramesRequestSchema,
  wireProbeRequestSchema,
  framesToWire,
  type WireFramesResult,
} from "./wire.ts";
import { parseInput, type CutsResult, type LoudnessResult, type ProbeResult, type TimelineResult } from "./types.ts";

export type HandlerOptions = {
  urlPolicy?: UrlPolicy;
  fetchImpl?: typeof fetch;
  paths?: ToolPaths;
  maxBodyBytes?: number;
};

const STATUS_BY_KIND: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  unknown_price: 422,
  config: 500,
  internal: 500,
};

export function errorStatus(error: EngineError): number {
  if (error.kind === "provider") {
    return error.retryable ? 503 : 502;
  }
  return STATUS_BY_KIND[error.kind] ?? 500;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof EngineError) {
    return json(errorStatus(error), {
      error: {
        kind: error.kind,
        retryable: error.retryable,
        message: error.message,
        stage: error.stage ?? null,
      },
    });
  }
  // A structured log line with the error's class only: messages and stacks can carry paths or media details (Bible 15.3).
  const name = error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: "error", event: "media.unexpected_error", name }));
  return json(500, {
    error: {
      kind: "internal",
      retryable: false,
      message: "unexpected media function error",
      stage: null,
    },
  });
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new EngineError("invalid_input", `the request body is larger than ${maxBytes} bytes`, {
      stage: "media.http",
    });
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new EngineError("invalid_input", `the request body is larger than ${maxBytes} bytes`, {
      stage: "media.http",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineError("invalid_input", "the request body is not JSON", { stage: "media.http" });
  }
}

type Route = (body: unknown, options: HandlerOptions) => Promise<unknown>;

const ROUTES: Record<string, Route> = {
  "/probe": async (body, options) => {
    const input = parseInput(wireProbeRequestSchema, body, "media.http");
    const result: ProbeResult = await probe.run({ source: sourceFromWire(input.source) }, options);
    return result;
  },
  "/frames": async (body, options) => {
    const input = parseInput(wireFramesRequestSchema, body, "media.http");
    const result = await frames.run(
      {
        source: sourceFromWire(input.source),
        atMs: input.atMs,
        ...(input.longSidePx === undefined ? {} : { longSidePx: input.longSidePx }),
      },
      options,
    );
    const wire: WireFramesResult = framesToWire(result);
    return wire;
  },
  "/loudness": async (body, options) => {
    const input = parseInput(wireProbeRequestSchema, body, "media.http");
    const result: LoudnessResult = await loudness.run(
      { source: sourceFromWire(input.source) },
      options,
    );
    return result;
  },
  "/timeline": async (body, options) => {
    const input = parseInput(wireTimelineRequestSchema, body, "media.http");
    const result: TimelineResult = await timeline.run({ source: sourceFromWire(input.source) }, options);
    return result;
  },
  "/cuts": async (body, options) => {
    const input = parseInput(wireCutsRequestSchema, body, "media.http");
    const result: CutsResult = await cuts.run(
      { source: sourceFromWire(input.source), sceneScore: input.sceneScore },
      options,
    );
    return result;
  },
};

async function health(options: HandlerOptions): Promise<unknown> {
  const [ffmpeg, ffprobe] = await Promise.all([
    runTool("ffmpeg", ["-version"], {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.version,
      stage: "media.health",
      paths: options.paths,
    }),
    runTool("ffprobe", ["-version"], {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.version,
      stage: "media.health",
      paths: options.paths,
    }),
  ]);
  return {
    ok: true,
    ffmpeg: ffmpeg.stdout.toString("utf8").split("\n")[0] ?? "",
    ffprobe: ffprobe.stdout.toString("utf8").split("\n")[0] ?? "",
  };
}

async function route(request: Request, options: HandlerOptions): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path === "/health") {
    if (request.method !== "GET") {
      return json(405, {
        error: { kind: "invalid_input", retryable: false, message: "use GET", stage: null },
      });
    }
    return json(200, await health(options));
  }
  const handler = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  if (!handler) {
    return json(404, {
      error: {
        kind: "not_found",
        retryable: false,
        message: `no media function at ${path}`,
        stage: null,
      },
    });
  }
  if (request.method !== "POST") {
    return json(405, {
      error: { kind: "invalid_input", retryable: false, message: "use POST", stage: null },
    });
  }
  const body = await readJsonBody(
    request,
    options.maxBodyBytes ?? FFMPEG_LIMITS.maxRequestBodyBytes,
  );
  return json(200, await handler(body, options));
}

/** Handles one media request. Never throws: every failure is a typed JSON error response. */
export async function handleMediaRequest(
  request: Request,
  options: HandlerOptions = {},
): Promise<Response> {
  try {
    return await route(request, options);
  } catch (error) {
    return errorResponse(error);
  }
}
