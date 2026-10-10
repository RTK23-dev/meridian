/**
 * Representative frame selection for image judgments on video.
 *
 * A decision that looks at a video sees at most four frames: the hook (earliest), the middle beat, a proof or reveal
 * frame, and the call to action (latest). The selector is pure and deterministic. It only chooses among frames whose
 * timestamp the source reported. A frame without a real timestamp is never selected, and its timestamp is never
 * estimated, because a judgment that names a moment in the video must name the moment it actually saw.
 *
 * Relevance is deliberately simple and visible: a proof or reveal frame is one that carries observed on-screen text
 * (OCR). A frame without text is not chosen as proof just to fill the slot.
 */
import { createHash } from "node:crypto";

export const FRAME_SELECTION_VERSION = "representative-frames.v1";
export const MAX_REPRESENTATIVE_FRAMES = 4;

export type FrameRole = "hook" | "middle" | "proof" | "cta";

export type FrameCandidate = {
  /** The caller's stable identifier for the frame, e.g. its storage key. Recorded, never shown to a provider. */
  id: string;
  bytes: Uint8Array;
  /** Position in the source media, as the source reported it. Null when unknown, which makes the frame ineligible. */
  timestampMs: number | null;
  /** The source's duration. Used to find the middle of the media. Falls back to the span of the frames when unknown. */
  durationMs?: number | null;
  /** On-screen text observed in this frame, if OCR has run on it. */
  ocrText?: string;
};

export type SelectedFrame = {
  role: FrameRole;
  id: string;
  /** The real timestamp, exactly as the source reported it. */
  timestampMs: number;
  sha256: string;
  byteLength: number;
  ocrPresent: boolean;
  reason: string;
  bytes: Uint8Array;
};

export type OmittedFrame = {
  id: string;
  reason: "empty" | "no_timestamp" | "duplicate" | "not_selected";
};

export type FrameSelection = {
  version: typeof FRAME_SELECTION_VERSION;
  /** At most four frames, ordered by timestamp. */
  frames: SelectedFrame[];
  omitted: OmittedFrame[];
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Eligible = FrameCandidate & { timestampMs: number; sha256: string };

export function selectRepresentativeFrames(candidates: FrameCandidate[]): FrameSelection {
  const omitted: OmittedFrame[] = [];
  const seenHashes = new Set<string>();
  const eligible: Eligible[] = [];

  for (const candidate of candidates) {
    if (candidate.bytes.byteLength === 0) {
      omitted.push({ id: candidate.id, reason: "empty" });
      continue;
    }
    const timestamp = candidate.timestampMs;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
      omitted.push({ id: candidate.id, reason: "no_timestamp" });
      continue;
    }
    const sha256 = sha256Hex(candidate.bytes);
    if (seenHashes.has(sha256)) {
      omitted.push({ id: candidate.id, reason: "duplicate" });
      continue;
    }
    seenHashes.add(sha256);
    eligible.push({ ...candidate, timestampMs: timestamp, sha256 });
  }

  // Sorting by timestamp, then by id, makes the result independent of the order the caller listed the frames.
  eligible.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  if (eligible.length === 0) return { version: FRAME_SELECTION_VERSION, frames: [], omitted };

  const first = eligible[0]!;
  const last = eligible[eligible.length - 1]!;
  const chosen = new Map<string, { role: FrameRole; reason: string }>();
  chosen.set(first.id, { role: "hook", reason: `Earliest frame of the media, at ${first.timestampMs}ms.` });
  if (last.id !== first.id) {
    chosen.set(last.id, { role: "cta", reason: `Latest frame of the media, at ${last.timestampMs}ms.` });
  }

  const remaining = () => eligible.filter((frame) => !chosen.has(frame.id));
  const durationKnown = eligible.map((frame) => frame.durationMs).find((value): value is number => typeof value === "number" && value > 0);
  const middleAt = durationKnown !== undefined ? durationKnown / 2 : (first.timestampMs + last.timestampMs) / 2;
  const middle = remaining().reduce<Eligible | undefined>((best, frame) => {
    if (!best) return frame;
    return Math.abs(frame.timestampMs - middleAt) < Math.abs(best.timestampMs - middleAt) ? frame : best;
  }, undefined);
  if (middle) {
    chosen.set(middle.id, { role: "middle", reason: `Closest frame to the middle of the media (${Math.round(middleAt)}ms).` });
  }

  // Proof or reveal: the remaining frame with the most observed on-screen text. No text, no proof frame.
  const withText = remaining().filter((frame) => (frame.ocrText ?? "").trim().length > 0);
  const proof = withText.reduce<Eligible | undefined>((best, frame) => {
    if (!best) return frame;
    return (frame.ocrText ?? "").trim().length > (best.ocrText ?? "").trim().length ? frame : best;
  }, undefined);
  if (proof) {
    chosen.set(proof.id, { role: "proof", reason: "The frame with the most on-screen text observed by OCR." });
  }

  const frames: SelectedFrame[] = eligible
    .filter((frame) => chosen.has(frame.id))
    .map((frame) => {
      const choice = chosen.get(frame.id)!;
      return {
        role: choice.role,
        id: frame.id,
        timestampMs: frame.timestampMs,
        sha256: frame.sha256,
        byteLength: frame.bytes.byteLength,
        ocrPresent: (frame.ocrText ?? "").trim().length > 0,
        reason: choice.reason,
        bytes: frame.bytes,
      };
    });
  for (const frame of eligible) {
    if (!chosen.has(frame.id)) omitted.push({ id: frame.id, reason: "not_selected" });
  }
  return { version: FRAME_SELECTION_VERSION, frames, omitted };
}
