// Which videos of a request are delivered (Video Engine Bible 6.14). A video is one edit (the master, or a variant of it) with its
// rendered MP4. An edit is delivered when its newest render that has a passing post-render review exists. A render without a pass
// does not deliver its edit: a failed or escalated variant is reported as not delivered, and the master must deliver or the request
// does not. Pure: it reads the artifact bodies the handler has already parsed.

import { EngineError, type EditDecisionList, type RenderedVideo, type ReviewResult } from "../contracts/index.ts";

export type Stored<T> = { body: T; createdAt: string };

export type VideoPick = {
  edl: EditDecisionList;
  videoId: string;
  /** The composition hash the render was keyed by (RenderedVideo.idempotencyKey). It names the ledger rows of the render. */
  renderKey: string;
  /** When the passing review was written: the video was ready then. */
  readyAt: string;
};

export type Undelivered = { edlId: string; reason: string };

export type VideoSelection = {
  master: VideoPick;
  /** The delivered variants, ordered by EDL id. */
  variants: VideoPick[];
  /** The EDLs that did not deliver, and why. A variant the orchestrator escalated shows up here. */
  undelivered: Undelivered[];
};

/** Chooses the delivered video of each EDL. Throws when there is no single master, or the master does not deliver. */
export function selectVideos(input: {
  edls: readonly Stored<EditDecisionList>[];
  renders: readonly Stored<RenderedVideo>[];
  reviews: readonly Stored<ReviewResult>[];
}): VideoSelection {
  const masters = input.edls.filter((edl) => edl.body.variantOf === undefined);
  if (masters.length !== 1) {
    throw new EngineError("invalid_input", `delivery needs exactly one master EDL, and it has ${masters.length}`, { stage: "deliver" });
  }
  const master = masters[0];
  if (master === undefined) throw new EngineError("invalid_input", "delivery needs a master EDL", { stage: "deliver" });

  const undelivered: Undelivered[] = [];
  const deliveredVideo = (edl: Stored<EditDecisionList>): VideoPick | string => {
    const rendered = input.renders.filter((render) => render.body.edlId === edl.body.edlId);
    if (rendered.length === 0) return "not rendered";
    const newestFirst = [...rendered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const render of newestFirst) {
      const review = input.reviews.find((candidate) => candidate.body.videoId === render.body.videoId);
      if (review !== undefined && review.body.result.pass) {
        return { edl: edl.body, videoId: render.body.videoId, renderKey: render.body.idempotencyKey, readyAt: review.createdAt };
      }
    }
    return "no render has a passing post-render review";
  };

  const picked = deliveredVideo(master);
  if (typeof picked === "string") {
    throw new EngineError("invalid_input", `the master does not deliver: ${picked}`, { stage: "deliver" });
  }

  const variants: VideoPick[] = [];
  const variantEdls = input.edls.filter((edl) => edl.body.variantOf !== undefined).sort((a, b) => a.body.edlId.localeCompare(b.body.edlId));
  for (const edl of variantEdls) {
    if (edl.body.variantOf !== master.body.edlId) {
      undelivered.push({ edlId: edl.body.edlId, reason: "its variantOf is not the master EDL" });
      continue;
    }
    const video = deliveredVideo(edl);
    if (typeof video === "string") {
      undelivered.push({ edlId: edl.body.edlId, reason: video });
    } else {
      variants.push(video);
    }
  }
  return { master: picked, variants, undelivered };
}
