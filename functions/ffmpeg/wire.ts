// The HTTP form of the media functions: JSON bodies, with media and PNG bytes as base64. The serverless handler and the
// HTTP client both use these schemas, so the contract is one file.

import { z } from "zod";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import {
  mediaUrlSchema,
  sceneScoreSchema,
  MAX_FRAMES_PER_CALL,
  type FramesResult,
  type MediaSource,
} from "./types.ts";

const MAX_INLINE_BASE64_CHARS = Math.ceil((FFMPEG_LIMITS.maxInlineBytes * 4) / 3) + 4;
const MAX_PNG_BASE64_CHARS = Math.ceil((FFMPEG_LIMITS.maxFramePngBytes * 4) / 3) + 4;

export const wireSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("url"), url: mediaUrlSchema }),
  z.strictObject({ kind: z.literal("bytes"), base64: z.base64().max(MAX_INLINE_BASE64_CHARS) }),
]);
export type WireSource = z.infer<typeof wireSourceSchema>;

export const wireProbeRequestSchema = z.strictObject({ source: wireSourceSchema });
export const wireLoudnessRequestSchema = wireProbeRequestSchema;
export const wireCutsRequestSchema = z.strictObject({
  source: wireSourceSchema,
  sceneScore: sceneScoreSchema,
});
export const wireFramesRequestSchema = z.strictObject({
  source: wireSourceSchema,
  atMs: z.array(z.int().nonnegative()).min(1).max(MAX_FRAMES_PER_CALL),
  longSidePx: z.int().min(64).max(2160).optional(),
});

export const wireFramesResultSchema = z.strictObject({
  frames: z.array(
    z.strictObject({
      atMs: z.int().nonnegative(),
      width: z.int().positive(),
      height: z.int().positive(),
      pngBase64: z.base64().max(MAX_PNG_BASE64_CHARS),
    }),
  ),
});
export type WireFramesResult = z.infer<typeof wireFramesResultSchema>;

/**
 * Converts an in-process source to its wire form. Bytes become base64. Bytes above the inline limit are refused here,
 * before any request is sent: media that large must be passed by URL.
 */
export function sourceToWire(source: MediaSource): WireSource {
  if (source.kind === "url") {
    return { kind: "url", url: source.url };
  }
  if (source.bytes.byteLength > FFMPEG_LIMITS.maxInlineBytes) {
    throw new EngineError(
      "invalid_input",
      `inline media is ${source.bytes.byteLength} bytes, above the ${FFMPEG_LIMITS.maxInlineBytes} byte inline limit; pass a URL`,
      { stage: "media.client" },
    );
  }
  return { kind: "bytes", base64: Buffer.from(source.bytes).toString("base64") };
}

/** Converts a validated wire source to its in-process form. */
export function sourceFromWire(source: WireSource): MediaSource {
  if (source.kind === "url") {
    return { kind: "url", url: source.url };
  }
  return { kind: "bytes", bytes: new Uint8Array(Buffer.from(source.base64, "base64")) };
}

export function framesToWire(result: FramesResult): WireFramesResult {
  return {
    frames: result.frames.map((frame) => ({
      atMs: frame.atMs,
      width: frame.width,
      height: frame.height,
      pngBase64: Buffer.from(frame.png).toString("base64"),
    })),
  };
}
