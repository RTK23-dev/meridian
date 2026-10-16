// The production media functions: the serverless deployment behind an injected transport. Composition roots call this
// and pass the result to production code as MediaFunctions.

import { EngineError } from "../contracts/errors.ts";
import { cutsOverWire, type CutsClient } from "./cuts.ts";
import { detectorsOverWire } from "./detectors.ts";
import { framesOverWire, type FramesClient } from "./frames.ts";
import type { MediaDetectors, MediaFunctions } from "./interface.ts";
import { loudnessOverWire, type LoudnessClient } from "./loudness.ts";
import { pictureOverWire, type PictureClient } from "./picture.ts";
import { probeOverWire, type ProbeClient } from "./probe.ts";
import { timelineOverWire, type TimelineClient } from "./timeline.ts";
import { wirePost, type MediaTransport } from "./wire-client.ts";

export type HttpMediaFunctions = MediaFunctions &
  MediaDetectors & {
    probe: ProbeClient;
    frames: FramesClient;
    loudness: LoudnessClient;
    cuts: CutsClient;
    timeline: TimelineClient;
    /** The picture measures (zoom and loop). Not part of MediaFunctions: only the analyze readings take it. */
    picture: PictureClient;
  };

/**
 * MediaFunctions over HTTP. baseUrl is the deployment's root (for example https://media.example.internal). The
 * transport does the network I/O and any authentication, which the caller provides from the credential resolver.
 */
export function httpMediaFunctions(baseUrl: string, transport: MediaTransport): HttpMediaFunctions {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new EngineError("config", "the media function base URL is not a valid URL", {
      stage: "media.client",
    });
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new EngineError("config", "the media function base URL must use http or https", {
      stage: "media.client",
    });
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
  const post = wirePost(root, transport);
  const detectors = detectorsOverWire(post);
  return {
    id: `http:${base.host}`,
    probe: probeOverWire(post),
    frames: framesOverWire(post),
    loudness: loudnessOverWire(post),
    cuts: cutsOverWire(post),
    timeline: timelineOverWire(post),
    picture: pictureOverWire(post),
    blackFrames: detectors.blackFrames,
    flicker: detectors.flicker,
    motion: detectors.motion,
    silence: detectors.silence,
  };
}
