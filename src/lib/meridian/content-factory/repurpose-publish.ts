// Whether one repurposed variation may be published, and if not, which condition stops it. Pure: it reads the state the caller has
// already loaded, and sends nothing. The first failing condition is the reason, so the screen can name the step that fixes it.
//
// A variation can publish only when it is rendered, a reviewer approved it, its own stored video exists, and a Meta account for the
// brand is connected. The approval already required a valid rights record for every file the cut was made from (repurpose-review.ts),
// so this gate does not re-check rights.
//
// Not built here: the upload itself, a receipt for it, measurement and learning. A repurposed variation is not a library creative
// yet, so the existing publishing queue cannot carry it (see the Repurpose panel's note).

import type { RepurposeVariationStatus } from "./repurpose.ts";
import type { RepurposeReviewState } from "./repurpose-review.ts";

export type RepurposePublishBlock = "not_rendered" | "not_approved" | "no_stored_video" | "not_connected";

export type RepurposePublishReadiness =
  | { state: "ready" }
  | { state: "blocked"; block: RepurposePublishBlock; reason: string };

export type RepurposePublishInput = {
  variantStatus: RepurposeVariationStatus;
  review: RepurposeReviewState;
  /** Whether the variation's own rendered video is stored and readable. */
  hasStoredVideo: boolean;
  /** Whether a Meta account with a saved token and an ad account is connected for the brand. */
  metaConnected: boolean;
};

const REASONS: Record<RepurposePublishBlock, string> = {
  not_rendered: "This variation is not rendered yet, so there is no video to publish.",
  not_approved: "A reviewer has not approved this rendered variation. Approve it in the review step first.",
  no_stored_video: "The rendered video for this variation is not stored, so it cannot be sent. Nothing was published.",
  not_connected: "No Meta account is connected for this brand. Connect one in Settings, then publishing is possible. Nothing was sent.",
};

/** The first condition that stops publishing, in the order a person would fix them, or ready when none does. */
export function repurposePublishReadiness(input: RepurposePublishInput): RepurposePublishReadiness {
  if (input.variantStatus !== "rendered") return blocked("not_rendered");
  if (input.review.status !== "approved") return blocked("not_approved");
  if (!input.hasStoredVideo) return blocked("no_stored_video");
  if (!input.metaConnected) return blocked("not_connected");
  return { state: "ready" };
}

function blocked(block: RepurposePublishBlock): RepurposePublishReadiness {
  return { state: "blocked", block, reason: REASONS[block] };
}
