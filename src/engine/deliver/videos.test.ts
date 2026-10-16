import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type EditDecisionList, type RenderedVideo, type ReviewResult } from "../contracts/index.ts";
import { edlFixture, FIXTURE_IDS, fixtureId, renderedVideoFixture, reviewResultFixture } from "../contracts/fixtures/index.ts";
import { withCaptionBand } from "../variants/diff.ts";
import { selectVideos, type Stored } from "./videos.ts";

const VARIANT_EDL = fixtureId("edl_", 60);
const VARIANT_VIDEO = fixtureId("vid_", 61);
const SECOND_VARIANT_VIDEO = fixtureId("vid_", 62);

const master: Stored<EditDecisionList> = { body: edlFixture, createdAt: "2026-10-13T09:05:00.000Z" };
const variant: Stored<EditDecisionList> = {
  body: { ...withCaptionBand(edlFixture, "upper").edl, edlId: VARIANT_EDL, variantOf: FIXTURE_IDS.edl },
  createdAt: "2026-10-13T09:20:00.000Z",
};

function render(videoId: string, edlId: string, createdAt: string, key = `sha256:${"b".repeat(64)}`): Stored<RenderedVideo> {
  return { body: { ...renderedVideoFixture, videoId, edlId, idempotencyKey: key }, createdAt };
}

function review(videoId: string, pass: boolean, createdAt: string): Stored<ReviewResult> {
  const result = pass
    ? reviewResultFixture.result
    : { ...reviewResultFixture.result, pass: false, checks: [{ rule: "claims_on_screen", pass: false, detail: "a claim is off the list" }] };
  return {
    body: { ...reviewResultFixture, videoId, result, failures: pass ? [] : [{ rule: "claims_on_screen" }] },
    createdAt,
  };
}

describe("choosing the delivered video of each edit", () => {
  it("delivers the master and each variant whose render has a passing review", () => {
    const selection = selectVideos({
      edls: [master, variant],
      renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z"), render(VARIANT_VIDEO, VARIANT_EDL, "2026-10-13T09:25:00.000Z")],
      reviews: [review(FIXTURE_IDS.video, true, "2026-10-13T09:07:00.000Z"), review(VARIANT_VIDEO, true, "2026-10-13T09:26:00.000Z")],
    });
    assert.equal(selection.master.videoId, FIXTURE_IDS.video);
    assert.equal(selection.master.readyAt, "2026-10-13T09:07:00.000Z");
    assert.deepEqual(
      selection.variants.map((item) => item.videoId),
      [VARIANT_VIDEO],
    );
    assert.deepEqual(selection.undelivered, []);
  });

  it("does not deliver a variant whose review failed or whose render is missing, and says why", () => {
    const selection = selectVideos({
      edls: [master, variant],
      renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z"), render(VARIANT_VIDEO, VARIANT_EDL, "2026-10-13T09:25:00.000Z")],
      reviews: [review(FIXTURE_IDS.video, true, "2026-10-13T09:07:00.000Z"), review(VARIANT_VIDEO, false, "2026-10-13T09:26:00.000Z")],
    });
    assert.deepEqual(selection.variants, []);
    assert.deepEqual(selection.undelivered, [{ edlId: VARIANT_EDL, reason: "no render has a passing post-render review" }]);

    const notRendered = selectVideos({
      edls: [master, variant],
      renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z")],
      reviews: [review(FIXTURE_IDS.video, true, "2026-10-13T09:07:00.000Z")],
    });
    assert.deepEqual(notRendered.undelivered, [{ edlId: VARIANT_EDL, reason: "not rendered" }]);
  });

  it("delivers the newest render of an edit that has a passing review, not an older one that failed", () => {
    const selection = selectVideos({
      edls: [master],
      renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z"), render(SECOND_VARIANT_VIDEO, FIXTURE_IDS.edl, "2026-10-13T09:12:00.000Z")],
      reviews: [review(FIXTURE_IDS.video, false, "2026-10-13T09:07:00.000Z"), review(SECOND_VARIANT_VIDEO, true, "2026-10-13T09:13:00.000Z")],
    });
    assert.equal(selection.master.videoId, SECOND_VARIANT_VIDEO);
  });

  it("refuses a request whose master does not deliver", () => {
    assert.throws(
      () =>
        selectVideos({
          edls: [master],
          renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z")],
          reviews: [review(FIXTURE_IDS.video, false, "2026-10-13T09:07:00.000Z")],
        }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /master does not deliver/.test(error.message),
    );
  });

  it("refuses a request with no master or with two", () => {
    assert.throws(() => selectVideos({ edls: [variant], renders: [], reviews: [] }), (error: unknown) => error instanceof EngineError);
    const second: Stored<EditDecisionList> = { body: { ...edlFixture, edlId: fixtureId("edl_", 70) }, createdAt: master.createdAt };
    assert.throws(() => selectVideos({ edls: [master, second], renders: [], reviews: [] }), (error: unknown) => error instanceof EngineError);
  });

  it("reports a variant whose variantOf is not the master, and does not deliver it", () => {
    const stray: Stored<EditDecisionList> = { body: { ...variant.body, edlId: fixtureId("edl_", 71), variantOf: fixtureId("edl_", 72) }, createdAt: variant.createdAt };
    const selection = selectVideos({
      edls: [master, stray],
      renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z"), render(VARIANT_VIDEO, stray.body.edlId, "2026-10-13T09:25:00.000Z")],
      reviews: [review(FIXTURE_IDS.video, true, "2026-10-13T09:07:00.000Z"), review(VARIANT_VIDEO, true, "2026-10-13T09:26:00.000Z")],
    });
    assert.deepEqual(selection.variants, []);
    assert.equal(selection.undelivered[0]?.reason, "its variantOf is not the master EDL");
  });

  it("a passing review of a variant does not deliver the master", () => {
    assert.throws(
      () =>
        selectVideos({
          edls: [master, variant],
          renders: [render(FIXTURE_IDS.video, FIXTURE_IDS.edl, "2026-10-13T09:06:00.000Z"), render(VARIANT_VIDEO, VARIANT_EDL, "2026-10-13T09:25:00.000Z")],
          reviews: [review(VARIANT_VIDEO, true, "2026-10-13T09:26:00.000Z")],
        }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});
