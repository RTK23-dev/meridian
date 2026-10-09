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
export function compressEvidenceForJev(
  bundle: EvidenceBundle,
  question?: import("../jev/types.ts").JevQuestionSpec,
): {
  description: string;
  source: string;
  platform: string;
  contentType: string;
  metrics: Record<string, number | undefined>;
  transcriptSummary?: string;
  sceneSummary?: string;
  scenes?: Array<{
    index: number;
    startMs: number;
    endMs: number;
    shotType?: string;
    facePresence?: boolean;
    productPresence?: boolean;
    keyframeRef?: string;
  }>;
  ocr?: Array<{ text: string; role?: string; startMs: number; endMs: number }>;
  comments?: Array<{ text: string; intent?: string }>;
  comparisonContext?: unknown;
  creatorBaseline?: unknown;
  availableEvidence: string[];
  evidenceRefs: import("../jev/types.ts").EvidenceRef[];
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

  const evidenceRefs: import("../jev/types.ts").EvidenceRef[] = [];
  if (bundle.provenance?.sourceUrl) {
    evidenceRefs.push({
      kind: "url",
      path: bundle.provenance.sourceUrl,
      summary: `Source: ${bundle.source?.platform || "media"}`,
    });
  }

  const qId = question?.id || "";

  // 1. Visual Craft focus
  const isVisualCraft = qId.includes("visual_craft") || qId.includes("visual");
  // 2. Retention Architecture focus
  const isRetention = qId.includes("retention") || qId.includes("pacing");
  // 3. Share Trigger focus
  const isShareTrigger = qId.includes("share_trigger") || qId.includes("audience");
  // 4. Transferability focus
  const isTransferability = qId.includes("transferability") || qId.includes("category");

  const includeScenes = !qId || isVisualCraft || isRetention;
  const includeOcr = !qId || isVisualCraft;
  const includeTranscript = !qId || isRetention;
  const includeComments = !qId || isShareTrigger;
  const includeContext = !qId || isTransferability;

  const transcriptSummary = includeTranscript && bundle.transcript
    ? bundle.transcript.map((t) => `[${(t.startMs / 1000).toFixed(1)}s-${(t.endMs / 1000).toFixed(1)}s] ${t.text}`).join(" ")
    : undefined;

  if (includeTranscript && bundle.transcript) {
    for (const t of bundle.transcript.slice(0, 5)) {
      evidenceRefs.push({
        kind: "metric",
        path: `transcript:${t.startMs}-${t.endMs}`,
        summary: t.text.slice(0, 100),
      });
    }
  }

  const sceneSummary = includeScenes && bundle.scenes
    ? `Total scenes: ${bundle.scenes.length}. Cut cadence: ${(bundle.scenes.reduce((acc, s) => acc + (s.endMs - s.startMs), 0) / (bundle.scenes.length * 1000 || 1)).toFixed(2)}s/cut.`
    : undefined;

  const scenes = includeScenes
    ? bundle.scenes?.slice(0, 15).map((s) => {
        if (s.keyframeRef) {
          evidenceRefs.push({
            kind: "url",
            path: s.keyframeRef,
            summary: `Keyframe scene ${s.index}`,
          });
        }
        return {
          index: s.index,
          startMs: s.startMs,
          endMs: s.endMs,
          shotType: s.shotType,
          facePresence: s.facePresence,
          productPresence: s.productPresence,
          keyframeRef: s.keyframeRef,
        };
      })
    : undefined;

  const ocr = includeOcr
    ? bundle.ocr?.slice(0, 15).map((o) => {
        evidenceRefs.push({
          kind: "metric",
          path: `ocr:${o.startMs}-${o.endMs}`,
          summary: o.text,
        });
        return {
          text: o.text,
          role: o.role,
          startMs: o.startMs,
          endMs: o.endMs,
        };
      })
    : undefined;

  const comments = includeComments
    ? bundle.comments?.slice(0, 10).map((c, idx) => {
        evidenceRefs.push({
          kind: "metric",
          path: `comment:${idx}`,
          summary: c.text.slice(0, 100),
        });
        return {
          text: c.text,
          intent: c.intentCategory,
        };
      })
    : undefined;

  return {
    description: `${bundle.content?.title || "Untitled"} - ${bundle.content?.caption || ""}`,
    source: bundle.source?.canonicalUrl || bundle.source?.externalId || bundle.id,
    platform: bundle.source?.platform || "media",
    contentType: bundle.content?.type || "video",
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
    scenes,
    ocr,
    comments,
    comparisonContext: includeContext ? bundle.comparisonContext : undefined,
    creatorBaseline: includeContext ? bundle.profile : undefined,
    availableEvidence,
    evidenceRefs,
  };
}
