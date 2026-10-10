/**
 * Builds the trace timeline for one creative. Pure: the route passes in data it already loaded, and the stages come out in
 * the fixed order opportunity, decision, brief, generation, QA, review, publish, performance. A stage with no record says
 * so. It is never filled with a guess.
 */
import { decisionEngineLine } from "../../lib/copy.ts";
import type { LibraryMediaVariant, MediaLoad } from "./library-model";

export const TRACE_STAGES = ["opportunity", "decision", "brief", "generation", "qa", "review", "publish", "performance"] as const;
export type TraceStageId = (typeof TRACE_STAGES)[number];

export const TRACE_STAGE_LABEL: Record<TraceStageId, string> = {
  opportunity: "Opportunity",
  decision: "Decision",
  brief: "Brief",
  generation: "Generation",
  qa: "QA",
  review: "Review",
  publish: "Publish",
  performance: "Performance",
};

export type TraceInput = {
  creativeId: string;
  creativeStatus: string;
  opportunity: { label: string; reason: string } | null;
  decisions: readonly { id: string; question: string; decision: string; probability: number; reasons: readonly string[]; createdAt: string }[];
  brief: { title: string; status: string; why: readonly string[]; learningNotes: readonly string[]; failureNotes: readonly string[] } | null;
  observations: readonly { observedOn: string; impressions: number; clicks: number; conversions: number; ctr: number | null; cpmCents: number | null; source: string }[];
  /** Whether the media for this creative has loaded. Media is not known until it has. */
  mediaLoad: MediaLoad;
  media: readonly LibraryMediaVariant[];
  /** Whether the reviews list has loaded. Reviews are not known until it has. */
  reviewsLoad: MediaLoad;
  reviews: readonly { creativeId: string; status: string; decision: string; createdAt: string }[];
  /** True when the reviews list is the server's 40-row window, so an older review may exist outside it. */
  reviewsTruncated: boolean;
};

/** The note for a stage whose source has not answered. An empty stage is not claimed while its source is still unknown. */
function sourceNote(load: MediaLoad, loading: string, failed: string): string | undefined {
  if (load === "loading") return loading;
  if (load === "unavailable") return failed;
  return undefined;
}

export type TraceEntry = { key: string; title: string; detail: string; at: string };

export type TraceStage = {
  id: TraceStageId;
  label: string;
  recorded: boolean;
  entries: TraceEntry[];
  /** Shown in place of the entries when the stage is not recorded. */
  note: string;
};

const MISSING_NOTES: Record<TraceStageId, string> = {
  opportunity: "No opportunity is linked. This creative was recorded directly.",
  decision: "No decision is linked to this creative.",
  brief: "No brief is linked to this creative.",
  generation: "No generated media is linked to this creative.",
  qa: "No QA verdict is recorded on its media.",
  review: "No review is linked to this creative.",
  publish: "Not part of this trace. A missing publish row here does not mean nothing was published.",
  performance: "No performance is entered.",
};

/** Time order for entries. Entries without a readable time keep their place at the end. */
function compareAt(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  const aKnown = !Number.isNaN(a);
  const bKnown = !Number.isNaN(b);
  if (aKnown && bKnown) return a - b;
  if (aKnown) return -1;
  if (bKnown) return 1;
  return 0;
}

function stage(id: TraceStageId, entries: TraceEntry[], missingNote?: string): TraceStage {
  const sorted = [...entries].sort((left, right) => compareAt(left.at, right.at));
  return {
    id,
    label: TRACE_STAGE_LABEL[id],
    recorded: sorted.length > 0,
    entries: sorted,
    note: missingNote ?? MISSING_NOTES[id],
  };
}

export function buildTraceTimeline(input: TraceInput): TraceStage[] {
  const opportunity = input.opportunity
    ? [{ key: "opportunity", title: input.opportunity.label || "Opportunity", detail: input.opportunity.reason, at: "" }]
    : [];

  const decisions = input.decisions.map((item) => ({
    key: `decision-${item.id}`,
    title: decisionEngineLine({ decision: item.decision, probability: item.probability }),
    detail: `${item.question}${item.reasons[0] ? ` · ${item.reasons[0]}` : ""}`,
    at: item.createdAt,
  }));

  const brief: TraceEntry[] = input.brief
    ? [
        { key: "brief", title: input.brief.title || "Brief", detail: input.brief.status ? `Status ${input.brief.status}` : "Status not recorded", at: "" },
        ...input.brief.why.map((line, index) => ({ key: `brief-why-${index}`, title: "Why", detail: line, at: "" })),
        ...input.brief.learningNotes.map((line, index) => ({ key: `brief-learned-${index}`, title: "Learned", detail: line, at: "" })),
        ...input.brief.failureNotes.map((line, index) => ({ key: `brief-failure-${index}`, title: "Failure", detail: line, at: "" })),
      ]
    : [];

  const media = [...input.media].sort((left, right) => left.index - right.index);
  const mediaNote = sourceNote(input.mediaLoad, "Loading media for this creative.", "Media could not be loaded, so this stage is not known.");
  const generation = media.map((variant) => ({
    key: `media-${variant.assetId || variant.index}`,
    title: `${variant.kind === "video" ? "Video" : "Image"} variant ${variant.index + 1}`,
    detail: `${variant.provider || "Provider not recorded"}${variant.model ? ` · ${variant.model}` : ""} · media ${variant.mediaStatus || "not recorded"}`,
    at: "",
  }));

  const qa = media
    .filter((variant) => variant.qaDecision.trim().length > 0)
    .map((variant) => ({
      key: `qa-${variant.assetId || variant.index}`,
      title: `QA verdict on variant ${variant.index + 1}`,
      detail: variant.qaDecision,
      at: "",
    }));

  const linkedReviews = input.reviews.filter((review) => review.creativeId === input.creativeId);
  let reviewEntries: TraceEntry[] = linkedReviews.map((review, index) => ({
    key: `review-${index}-${review.createdAt}`,
    title: `Review ${review.status || "status not recorded"}`,
    detail: review.decision || "Decision not recorded",
    at: review.createdAt,
  }));
  if (reviewEntries.length === 0 && (input.creativeStatus === "approved" || input.creativeStatus === "rejected")) {
    reviewEntries = [{
      key: "review-creative-status",
      title: `Creative ${input.creativeStatus}`,
      detail: "Set on the creative record. No review row is loaded for it.",
      at: "",
    }];
  }
  const reviewMissing = sourceNote(input.reviewsLoad, "Loading reviews for this creative.", "Reviews could not be loaded, so this stage is not known.")
    ?? (input.reviewsTruncated ? "No review is in the 40 most recent reviews loaded here. An older review may exist." : undefined);

  const observations = input.observations.map((item) => ({
    key: `performance-${item.observedOn}-${item.impressions}-${item.clicks}-${item.conversions}-${item.source}`,
    title: item.observedOn,
    detail: `${item.impressions} impressions, ${item.clicks} clicks, ${item.conversions} conversions. ${item.ctr === null ? "CTR not computable." : `CTR ${(item.ctr * 100).toFixed(1)}%.`}${item.cpmCents === null ? "" : ` CPM ${item.cpmCents} cents.`} Source: ${item.source || "not recorded"}.`,
    at: item.observedOn,
  }));

  return [
    stage("opportunity", opportunity),
    stage("decision", decisions),
    stage("brief", brief),
    stage("generation", generation, mediaNote),
    stage("qa", qa, mediaNote),
    stage("review", reviewEntries, reviewMissing),
    stage("publish", []),
    stage("performance", observations),
  ];
}
