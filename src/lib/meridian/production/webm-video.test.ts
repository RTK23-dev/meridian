import assert from "node:assert/strict";
import test from "node:test";
import { isWebmWithVideoTrack } from "./webm-video.ts";
import { evaluateProductionPostflight } from "./postflight.ts";
import type { ProductionJob } from "./types.ts";
import { WEBM_TRACK_AUDIO as AUDIO, WEBM_TRACK_VIDEO as VIDEO, webmFixture as webmFile } from "../../../test-support/lib/meridian/testing/webm-fixture.ts";

test("isWebmWithVideoTrack: a WebM with a video track is recognized", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ tracks: [VIDEO] })), true);
});

test("isWebmWithVideoTrack: a Segment of unknown size is read to the end of the file", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ tracks: [VIDEO], unknownSegmentSize: true })), true);
});

test("isWebmWithVideoTrack: a WebM with a video and an audio track is recognized", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ tracks: [AUDIO, VIDEO] })), true);
});

test("isWebmWithVideoTrack: an audio-only WebM has no video track and is refused", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ tracks: [AUDIO] })), false);
});

test("isWebmWithVideoTrack: a WebM with no tracks is refused", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ tracks: [] })), false);
});

test("isWebmWithVideoTrack: a Matroska file with a video track is refused, since only WebM is accepted", () => {
  assert.equal(isWebmWithVideoTrack(webmFile({ docType: "matroska", tracks: [VIDEO] })), false);
});

test("isWebmWithVideoTrack: a file truncated inside its Segment is refused", () => {
  const whole = webmFile({ tracks: [VIDEO] });
  assert.equal(isWebmWithVideoTrack(whole.subarray(0, whole.byteLength - 20)), false);
  assert.equal(isWebmWithVideoTrack(whole.subarray(0, 40)), false);
});

test("isWebmWithVideoTrack: the EBML magic alone, an MP4, and random bytes are refused", () => {
  assert.equal(isWebmWithVideoTrack(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), false);
  assert.equal(isWebmWithVideoTrack(new Uint8Array(0)), false);
  const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
  assert.equal(isWebmWithVideoTrack(mp4), false);
  assert.equal(isWebmWithVideoTrack(new Uint8Array(64).fill(0xab)), false);
});

test("evaluateProductionPostflight: a WebM with a video track passes the container check", () => {
  const job: ProductionJob = {
    jobId: "job-webm-1",
    organizationId: "org-1",
    brandId: "brand-1",
    creativeSpec: {
      id: "spec-1",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Test",
      modality: "video",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    },
    providerId: "google_omni",
    status: "COMPLETED",
    costEstimateUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const passed = evaluateProductionPostflight({ job, videoBytes: webmFile({ tracks: [VIDEO] }) });
  assert.equal(passed.passed, true, passed.reasons.join("; "));

  const audioOnly = evaluateProductionPostflight({ job, videoBytes: webmFile({ tracks: [AUDIO] }) });
  assert.equal(audioOnly.passed, false);
  assert.equal(audioOnly.decision, "REJECT_DEFECTIVE");
  assert.ok(audioOnly.reasons.includes("Artifact is not a valid MP4 or WebM video container."), audioOnly.reasons.join("; "));
});
