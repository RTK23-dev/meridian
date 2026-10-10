/**
 * Post-generation QC across modalities (P4b-4).
 *
 * Every modality ends in a creative, and the creative's review status is the QC record a person acts on. QC is read from
 * that status when it is needed, never copied into a second place, so it cannot drift from what the review queue shows.
 *
 * Missing QC is PENDING, never PASS. A creative with no status, or a carousel whose slides are not all judged, has no
 * check that passed, so it is review, not a pass (AGENTS rule 8).
 */

export type QcVerdict = "PASS" | "REVIEW" | "REJECT" | "PENDING";

/** The verdict a creative's review status records. Unknown or absent status is PENDING. */
export function qcVerdictForStatus(status: string | null | undefined): QcVerdict {
  if (status === "approved") return "PASS";
  if (status === "rejected") return "REJECT";
  if (status === "in_review") return "REVIEW";
  return "PENDING";
}

export interface SlideQc {
  index: number;
  verdict: QcVerdict;
}

/**
 * A carousel is one creative judged by its slides. A rejected slide rejects the carousel. A slide still pending keeps it
 * pending. Otherwise the carousel's own status decides, and a carousel whose status is in review stays in review.
 */
export function carouselQcVerdict(slides: SlideQc[], carouselStatus: string | null | undefined): QcVerdict {
  if (slides.some((slide) => slide.verdict === "REJECT")) return "REJECT";
  if (slides.length === 0 || slides.some((slide) => slide.verdict === "PENDING")) return "PENDING";
  return qcVerdictForStatus(carouselStatus);
}
