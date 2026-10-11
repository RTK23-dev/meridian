/**
 * The visual read of a creative's still image or sampled video frames, server only.
 *
 * The read takes the image bytes themselves. It checks each item by its own magic bytes, a size cap, and a MIME type, and only
 * then sends it to the configured multimodal perception provider through the shared runner (perception/run.ts). That is the
 * same provider, credential, and run record creative QC uses. The read describes the pixels and judges nothing: its
 * observations go to the engine gate (studio/image-qc.server.ts), which asks the semantic questions. Perception receives no
 * copy, prompt, or brand text.
 */
import type { Sql } from "../learning/store.ts";
import { detectArtifactType } from "../production/mime-detector.ts";
import { runPerception, type PerceptionCoverage, type PerceptionInputMedia, type PerceptionRunOutcome } from "../perception/run.ts";
import type { MultimodalPerceptionProvider, PerceptionMediaKind } from "../perception/types.ts";

/** The most bytes one image may weigh in a visual read. A larger image is refused before anything is sent. */
export const VISUAL_READ_MAX_BYTES = 10 * 1024 * 1024;
/** The image types a visual read accepts, decided by their magic bytes. */
export const VISUAL_READ_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type VisualReadMimeType = (typeof VISUAL_READ_MIME_TYPES)[number];

export type VisualReadCheck = { ok: true; mimeType: VisualReadMimeType } | { ok: false; reason: string };

/**
 * Checks one image by its own bytes. The type comes from the leading bytes, never from a name, a header, or the caller's claim.
 * An empty, oversized, unreadable, or unsupported item is refused. So is an HTML or JSON error page that a provider returned.
 */
export function checkVisualReadBytes(bytes: Uint8Array, label: string): VisualReadCheck {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return { ok: false, reason: `${label} has no bytes.` };
  if (bytes.byteLength > VISUAL_READ_MAX_BYTES) {
    return { ok: false, reason: `${label} is ${bytes.byteLength} bytes; the limit is ${VISUAL_READ_MAX_BYTES}.` };
  }
  let detected: string;
  try {
    detected = detectArtifactType(bytes).mimeType;
  } catch (error) {
    return { ok: false, reason: `${label} is not a readable image: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!(VISUAL_READ_MIME_TYPES as readonly string[]).includes(detected)) {
    return { ok: false, reason: `${label} is ${detected}; accepted types are ${VISUAL_READ_MIME_TYPES.join(", ")}.` };
  }
  return { ok: true, mimeType: detected as VisualReadMimeType };
}

/**
 * Reads the visual evidence of one image or set of frames. Every item is checked before anything is sent: one invalid item
 * refuses the whole read, and the provider is not called. A refused read is returned as a failed outcome with no run id,
 * because nothing was analysed and no provider run exists. A read that is sent is recorded by the shared runner.
 *
 * `provider` is the perception provider to use. Null means none is ready, and the outcome says so.
 */
export async function readVisualMedia(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    subjectType: string;
    subjectId: string;
    kind: PerceptionMediaKind;
    media: PerceptionInputMedia[];
    durationMs?: number | null;
    provider: MultimodalPerceptionProvider | null;
    providerReason?: string;
  },
): Promise<PerceptionRunOutcome> {
  for (const [index, item] of input.media.entries()) {
    const checked = checkVisualReadBytes(item.bytes, `Media ${index + 1} (${item.label})`);
    if (!checked.ok) return refusedRead(input, checked.reason);
  }
  return runPerception(sql, input);
}

function refusedRead(
  input: { kind: PerceptionMediaKind; media: PerceptionInputMedia[]; durationMs?: number | null },
  reason: string,
): PerceptionRunOutcome {
  const coverage: PerceptionCoverage = {
    scope: input.kind === "image" ? "still_image" : "sampled_frames",
    offered: input.media.length,
    analysed: 0,
    durationMs: input.kind === "image" ? null : (input.durationMs ?? null),
    note: "No media was analysed: an item was refused before anything was sent.",
  };
  return {
    status: "failed",
    runId: "",
    reused: false,
    providerId: null,
    model: null,
    promptVersion: null,
    observations: [],
    media: [],
    coverage,
    failureKind: "unsupported_media",
    message: reason,
  };
}
