/**
 * Universal Evidence Bundle Operations
 *
 * Normalizes heterogeneous source data into canonical EvidenceBundles,
 * validates provenance, and compacts state before passing to JEV.
 */

import { getNumericEvidence, type EvidenceBundle } from "./types.ts";

export function createEvidenceBundle(
  input: Omit<EvidenceBundle, "id" | "createdAt"> & { id?: string },
): EvidenceBundle {
  return {
    id: input.id || globalThis.crypto.randomUUID(),
    organizationId: input.organizationId,
    brandId: input.brandId,
    source: input.source,
    content: input.content,
    profile: input.profile,
    performance: input.performance,
    transcript: input.transcript,
    scenes: input.scenes,
    ocr: input.ocr,
    audio: input.audio,
    comments: input.comments,
    derivedMetrics: input.derivedMetrics,
    comparisonContext: input.comparisonContext,
    provenance: input.provenance,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Compresses an EvidenceBundle into a compact structured state for JEV,
 * retaining key timestamps, evidence references, and non-redundant metrics.
 */
export function compressEvidenceForJev(bundle: EvidenceBundle): {
  description: string;
  source: string;
  platform: string;
  contentType: string;
  metrics: Record<string, number | undefined>;
  transcriptSummary: string;
  sceneSummary: string;
  availableEvidence: string[];
} {
  const availableEvidence: string[] = [];

  if (bundle.transcript && bundle.transcript.length > 0) availableEvidence.push("transcript");
  if (bundle.scenes && bundle.scenes.length > 0) {
    availableEvidence.push("scene_cuts");
    if (bundle.scenes.some((s) => s.keyframeRef || s.facePresence !== undefined)) {
      availableEvidence.push("scene_frames");
    }
  }
  if (bundle.ocr && bundle.ocr.length > 0) availableEvidence.push("ocr");
  if (bundle.comments && bundle.comments.length > 0) availableEvidence.push("comments");
  if (bundle.profile) availableEvidence.push("creator_baseline");
  if (bundle.performance) availableEvidence.push("performance_snapshot");
  if (bundle.comparisonContext) availableEvidence.push("comparison_context");

  const transcriptSummary = bundle.transcript
    ? bundle.transcript.map((t) => `[${(t.startMs / 1000).toFixed(1)}s-${(t.endMs / 1000).toFixed(1)}s] ${t.text}`).join(" ")
    : "No spoken audio transcribed.";

  const sceneSummary = bundle.scenes
    ? `Total scenes: ${bundle.scenes.length}. Cut cadence: ${(bundle.scenes.reduce((acc, s) => acc + (s.endMs - s.startMs), 0) / (bundle.scenes.length * 1000 || 1)).toFixed(2)}s/cut.`
    : "No visual scene cuts detected.";

  return {
    description: `${bundle.content.title || "Untitled"} - ${bundle.content.caption || ""}`,
    source: bundle.source.canonicalUrl || bundle.source.externalId || bundle.id,
    platform: bundle.source.platform,
    contentType: bundle.content.type,
    metrics: {
      views: getNumericEvidence(bundle.performance?.views),
      likes: getNumericEvidence(bundle.performance?.likes),
      comments: getNumericEvidence(bundle.performance?.comments),
      shares: getNumericEvidence(bundle.performance?.shares),
      creatorFollowers: bundle.profile?.followers,
      outlierRatio: bundle.comparisonContext?.outlierRatio,
    },
    transcriptSummary,
    sceneSummary,
    availableEvidence,
  };
}
