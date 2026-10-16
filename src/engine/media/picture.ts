// Client for the picture measures (Bible 6.2 step 6, 8.1 motion and endsOnLoop): the scale between neighbouring thumbnails and
// the difference between the first and the last frame. Two forms: in-process (tests and CI) and over HTTP (production). The
// answer is untrusted: it must match the result schema, and a failed check is a provider error, never a shorter result.

import { run as runPicture } from "../../../functions/ffmpeg/picture.ts";
import { sourceToWire, wirePictureRequestSchema } from "../../../functions/ffmpeg/wire.ts";
import {
  parseInput,
  pictureRequestSchema,
  pictureResultSchema,
  type PictureRequest,
  type PictureResult,
} from "../../../functions/ffmpeg/types.ts";
import { EngineError } from "../contracts/errors.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const PICTURE_PATH = "/picture";

export type PictureClient = (request: PictureRequest) => Promise<PictureResult>;

const STAGE = "media.picture";

/** Checks an answer of the picture function against its schema. A mismatch is a provider error. */
function decodeAnswer(value: unknown): PictureResult {
  const parsed = pictureResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError(
      "provider",
      `the picture measures do not match their contract: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      { stage: STAGE },
    );
  }
  return parsed.data;
}

/** In-process form: runs the picture handler here, through the ffmpeg on this machine (tests and CI). */
export function pictureInProcess(): PictureClient {
  return async (request) =>
    decodeAnswer(await runPicture(parseInput(pictureRequestSchema, request, STAGE)));
}

/** HTTP form: POST /picture on the media functions' deployment. */
export function pictureOverWire(post: WirePost): PictureClient {
  return async (request) => {
    const input = parseInput(pictureRequestSchema, request, STAGE);
    const body = { source: sourceToWire(input.source), cutsMs: input.cutsMs };
    parseInput(wirePictureRequestSchema, body, STAGE);
    return post(PICTURE_PATH, body, pictureResultSchema, mediaConfig.callTimeoutMs.picture);
  };
}
