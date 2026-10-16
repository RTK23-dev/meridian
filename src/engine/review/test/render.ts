// Test helpers for the pre-render and post-render gates: a clean EDL built by the editor from the E1 chain fixtures, its composition,
// the rendered video, a recorded-looking set of measurements and a recorded critic answer. Nothing here calls a live API or reads a
// key. The EDL is built by the same code the edit stage runs, so the clean case is the one the edit gate already passes.

import { contentHash, type Composition, type CompositionFile, type EditDecisionList, type RenderedVideo, type ScenePlan, type ShotSpec } from "../../contracts/index.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { compositionHash } from "../../contracts/render.ts";
import { buildEdl, type EditBuild } from "../../edit/editor.ts";
import { mediaUrisOf } from "../gates/preRender.ts";
import { requiredFrameTimes } from "../gates/postRender.ts";
import type { CriticFinalOutcome } from "../criticFinal.ts";
import type { FinalRubricItem } from "../../claude/roles/critic_final.ts";
import type { PreRenderInput } from "../gates/preRender.ts";
import type { PostRenderInput } from "../gates/postRender.ts";
import { goldMetrics, type GoldMetrics } from "../gold.ts";

export const VIDEO_ID = "vid_01JABCDEFGHJKMNPQRSTVWXYZ0";

export type CleanRender = {
  build: EditBuild;
  edl: EditDecisionList;
  plan: ScenePlan;
  composition: Composition;
  rendered: RenderedVideo;
};

/** The editor's EDL for the E1 chain, with its build result, and a composition and rendered video that match it. */
export function cleanRender(): CleanRender {
  const build = buildEdl({
    requestId: fx.productionRequestFixture.requestId,
    plan: fx.scenePlanFixture,
    voice: fx.voiceTrackFixture,
    grammar: fx.videoDnaFixture.editGrammar,
    referenceDurationMs: fx.videoDnaFixture.durationMs,
    takes: [fx.take1Fixture, fx.take2Fixture, fx.take3bFixture],
    kit: fx.styleKitFixture,
    emphasis: [{ beatId: "b1", term: "lying" }],
  });
  if (!build.pass || build.edl === null) {
    throw new Error(`the chain fixture no longer gives a passing EDL: ${build.checks.filter((check) => !check.pass).map((check) => check.rule).join(", ")}`);
  }
  const edl = build.edl;
  const files: CompositionFile[] = [
    { path: "index.html", contentHash: contentHash("<html></html>"), bytes: 13 },
    { path: "components/captions.html", contentHash: contentHash("<div></div>"), bytes: 11 },
  ];
  const composition: Composition = {
    schema: "meridian.composition/v1",
    compositionId: "cmp_01JABCDEFGHJKMNPQRSTVWXYZ0",
    edlId: edl.edlId,
    rootFile: "index.html",
    files,
    assetUris: mediaUrisOf(edl),
    contentHash: compositionHash(files),
  };
  const rendered: RenderedVideo = {
    videoId: VIDEO_ID,
    edlId: edl.edlId,
    uri: "store://renders/vid_clean.mp4",
    renderer: "hyperframes-cloud",
    durationMs: edl.durationMs,
    bytes: 6_400_000,
    estimateUsd: 0.05,
    costUsd: 0.047,
    idempotencyKey: composition.contentHash,
  };
  return { build, edl, plan: fx.scenePlanFixture, composition, rendered };
}

/** The kit the validated request names, and the request, both as the fixtures give them. */
export const cleanValidated = fx.validatedRequestFixture;
export const cleanVoice = fx.voiceTrackFixture;
export const cleanDna = fx.videoDnaFixture;
export const cleanKit = fx.styleKitFixture;
export const cleanTakes = [fx.take1Fixture, fx.take2Fixture, fx.take3bFixture];

/** The product imagery the plan's product shot uses: the fixture's hero image. */
export const PRODUCT_IMAGES = [fx.BLENDER_FRONT_URI];

/** A pre-render input that is clean on every check the caller can supply. A test overrides the field it changes. */
export function cleanPreRenderInput(render: CleanRender = cleanRender()): PreRenderInput {
  return {
    edl: render.edl,
    composition: render.composition,
    plan: render.plan,
    validated: cleanValidated,
    voice: cleanVoice,
    dna: cleanDna,
    takes: cleanTakes,
    styleKit: cleanKit,
    productImageUris: PRODUCT_IMAGES,
    disclosures: { aiGeneratedPeople: true },
    licensedUris: new Set(mediaUrisOf(render.edl)),
    renderBudget: { remainingUsd: 5, renderEstimateUsd: 0.5 },
  };
}

/** A clear measurement of every frame the gate asks for (the cuts and the sample positions), so no frame is unmeasured. */
export function clearBlackFrames(edl: EditDecisionList): Array<{ atMs: number; black: boolean }> {
  return requiredFrameTimes(edl).map((atMs) => ({ atMs, black: false }));
}

/** The graphics overlays, each drawn in its frame. */
export function drawnOverlays(edl: EditDecisionList): Array<{ clipId: string; present: boolean }> {
  return edl.tracks
    .filter((track) => track.layer === "graphics")
    .flatMap((track) => track.clips.map((clip) => ({ clipId: clip.clipId, present: true })));
}

/** A critic answer that scores every item well, with the given confidence. */
export function answeredCritic(score = 0.9, confidence = 0.9, answeredBy: "haiku" | "sonnet" = "haiku"): Extract<CriticFinalOutcome, { status: "answered" }> {
  const items: FinalRubricItem[] = [
    "hands",
    "faces",
    "anatomy",
    "physics",
    "plastic_skin",
    "morphing_objects",
    "background_warping",
    "captions_legible",
    "framing_in_safe_area",
  ];
  const rubric = Object.fromEntries(items.map((item) => [item, score])) as Record<FinalRubricItem, number>;
  return { status: "answered", rubric, confidence, answeredBy };
}

/** A clean integrity result for the video, as the render stage's gate reports it. */
export function integrityPassed(videoId = VIDEO_ID) {
  return {
    gate: "render_integrity",
    subjectId: videoId,
    pass: true,
    checks: [
      { rule: "resolution", pass: true },
      { rule: "duration_matches_edl", pass: true, value: 0, limit: 100 },
    ],
  };
}

/** A clean post-render input. A test overrides the field it changes. */
export function cleanPostRenderInput(render: CleanRender = cleanRender()): PostRenderInput {
  return {
    renderedVideo: render.rendered,
    edl: render.edl,
    integrity: integrityPassed(),
    loudness: { integratedLufs: -14, truePeakDbtp: -2 },
    silence: { longestMs: 120 },
    overlays: drawnOverlays(render.edl),
    blackFrames: clearBlackFrames(render.edl),
    ocr: { captionWordsChecked: 24, captionWordsMismatched: 0, onScreenText: ["Send BLEND to get the link"] },
    forbiddenTerms: ["miracle cure"],
    critic: answeredCritic(),
  };
}

export function shotOfPlan(plan: ScenePlan, shotId: string): ShotSpec {
  const shot = plan.shots.find((item) => item.shotId === shotId);
  if (!shot) throw new Error(`no shot ${shotId} in the fixture plan`);
  return shot;
}

/** Gold metrics that meet the target (12.4): 100 failing and 100 passing labels, every one predicted right. Blocking is allowed. */
export function provenMetrics(): GoldMetrics {
  const outcomes = [
    ...Array.from({ length: 100 }, () => ({ shouldFail: true, predictedFail: true })),
    ...Array.from({ length: 100 }, () => ({ shouldFail: false, predictedFail: false })),
  ];
  return goldMetrics(outcomes);
}

/** Gold metrics below the target: 100 failing and 100 passing labels, but 11 of the passing ones are false fails (11%, over 10%). */
export function unprovenMetrics(): GoldMetrics {
  const outcomes = [
    ...Array.from({ length: 100 }, () => ({ shouldFail: true, predictedFail: true })),
    ...Array.from({ length: 89 }, () => ({ shouldFail: false, predictedFail: false })),
    ...Array.from({ length: 11 }, () => ({ shouldFail: false, predictedFail: true })),
  ];
  return goldMetrics(outcomes);
}
