import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant, PNG_BASE64 } from "../testing/durable-image-fixtures.ts";
import { FRAME_SELECTION_VERSION } from "../decisions/frames.ts";
import { sampleTimestamps, type FrameExtractor } from "../video/sample-frames.ts";
import { solidFrame } from "../video/inspect.ts";
import { judgeMedia, type MediaFacts } from "./features.ts";
import { measureVideoFrames, sampleVideoForJudgment, videoVisualEvidence } from "./image-qc.server.ts";

// Recorded fixtures: each frame is a PNG the extractor returns for a timestamp. Its colour follows the timestamp, so no two frames
// are the same bytes. No ffmpeg runs and no provider is called.
const recordedFrame: FrameExtractor = async (_path, timestampMs) => solidFrame(16, 16, [Math.round(timestampMs / 12) % 256, 40, 200]);

// An extractor that decodes nothing: every timestamp fails, as a container with no decodable frame does.
const refusesEveryFrame: FrameExtractor = async () => {
  throw new Error("no decodable frame at this time");
};

const videoFacts: MediaFacts = {
  kind: "video",
  positioning: "Helps busy parents plan a calm dinner in ten minutes.",
  tone: "warm",
  prohibited: "",
  wordsToAvoid: "",
  productName: "MealKit",
  angle: "dinner in ten minutes",
  copy: "MealKit: a calm dinner in ten minutes.",
  prompt: "A short clip of MealKit.",
  competitorTexts: [],
  ownTexts: [],
  mime: "video/mp4",
  byteSize: 4096,
  width: 320,
  height: 240,
  checksum: "abc123def4567890",
  durationMs: 3000,
  transcript: "",
  sceneCount: 1,
  logoSimilarity: null,
  logoOutcome: "ABSENT",
  paletteDistance: null,
  paletteOutcome: "ABSENT",
  semanticSimilarity: null,
};

/** Stores a container for a video in the tenant and returns its storage key. Its bytes are never decoded by these tests. */
async function storedContainer(label: string, tenant: { organizationId: string; brandId: string }): Promise<string> {
  const sql = await getSql();
  const storageKey = `${label}-${randomUUID()}.mp4`;
  const body = Buffer.from("fixture container bytes").toString("base64");
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, lifecycle)
    values (${storageKey}, ${tenant.organizationId}, ${tenant.brandId}, ${body}, 'video/mp4', 'fixture', 23, 'stored')
  `;
  return storageKey;
}

test("representative frames are chosen at real timestamps, and the selection records its version, roles and timestamps", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "video-frames-selected");
  const storageKey = await storedContainer("clip", tenant);
  let extracted = 0;
  const sample = await sampleVideoForJudgment(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, {
    extractor: async (path, timestampMs) => {
      extracted += 1;
      return recordedFrame(path, timestampMs);
    },
  });
  const times = sampleTimestamps(3000);
  assert.equal(extracted, times.length, "every timestamp is decoded once");
  assert.equal(sample.unavailable, null);
  assert.equal(sample.offered, times.length);
  assert.equal(sample.selection?.version, FRAME_SELECTION_VERSION);
  const chosen = sample.selection?.frames ?? [];
  assert.deepEqual(chosen.map((frame) => frame.role), ["hook", "middle", "cta"]);
  assert.deepEqual(chosen.map((frame) => frame.timestampMs), [times[0], 1571, times[times.length - 1]]);
  assert.ok(chosen.every((frame) => times.includes(frame.timestampMs)), "each chosen frame sits at a timestamp that was decoded");
  assert.equal(sample.selection?.omitted.length, times.length - chosen.length);
});

test("when no frame decodes at a real timestamp, the video is not judged: the visual and the logo and palette checks say they could not judge", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "video-frames-none");
  const storageKey = await storedContainer("undecodable", tenant);
  const sample = await sampleVideoForJudgment(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, { extractor: refusesEveryFrame });
  assert.equal(sample.unavailable, "no_eligible_frame");
  assert.equal(sample.selection?.version, FRAME_SELECTION_VERSION, "the selection ran, so its version is recorded even though it chose nothing");
  assert.deepEqual(sample.selection?.frames, []);

  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, { sample: true, sampled: sample });
  assert.deepEqual(visual.media, [], "no frame is offered to a visual question");
  assert.equal(visual.coverage.unavailable, "no_eligible_frame");
  assert.equal(visual.selection?.version, FRAME_SELECTION_VERSION);
  assert.deepEqual(visual.selection?.frames, []);

  const measured = await measureVideoFrames(sql, tenant.organizationId, tenant.brandId, sample);
  assert.equal(measured.measuredLogo.outcome, "ABSENT");
  assert.equal(measured.measuredPalette.outcome, "ABSENT");
  assert.match(measured.measuredLogo.evidence, /no sampled frame could be decoded at its real timestamp/);
  assert.match(measured.measuredLogo.evidence, new RegExp(FRAME_SELECTION_VERSION.replace(".", "\\.")));

  const decisions = judgeMedia({
    ...videoFacts,
    logoOutcome: measured.measuredLogo.outcome,
    logoEvidence: measured.measuredLogo.evidence,
    paletteOutcome: measured.measuredPalette.outcome,
    paletteEvidence: measured.measuredPalette.evidence,
  });
  for (const id of ["logo_match", "palette_match"]) {
    const decision = decisions.find((item) => item.questionId === id);
    assert.ok(decision, `${id} is judged`);
    assert.notEqual(decision.decision, "AUTO_APPROVE", `${id} is never passed without a measured frame`);
  }
});

test("with no known duration nothing is sampled, and the reason is recorded", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "video-frames-no-duration");
  const storageKey = await storedContainer("untimed", tenant);
  let extracted = 0;
  const extractor: FrameExtractor = async (path, timestampMs) => {
    extracted += 1;
    return recordedFrame(path, timestampMs);
  };
  const sample = await sampleVideoForJudgment(sql, tenant.organizationId, tenant.brandId, storageKey, null, { extractor });
  assert.equal(extracted, 0, "no frame is decoded at an unknown time");
  assert.equal(sample.unavailable, "no_duration");
  assert.equal(sample.selection, null, "the selection did not run");
  const measured = await measureVideoFrames(sql, tenant.organizationId, tenant.brandId, sample);
  assert.equal(measured.measuredLogo.outcome, "ABSENT");
  assert.match(measured.measuredLogo.evidence, /duration is unknown/);
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, null, { sample: true, sampled: sample });
  assert.equal(visual.coverage.unavailable, "no_duration");
  assert.equal(visual.selection, undefined, "no selection is recorded when none ran");
});

test("the embedded stills stored beside a container are never judged, because they carry no timestamp", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "video-frames-embedded-only");
  const storageKey = `embedded-${randomUUID()}.mp4`;
  // Only the poster still stored beside the container exists. There is no container to decode a timed frame from.
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, lifecycle)
    values (${`${storageKey}.frame.0.png`}, ${tenant.organizationId}, ${tenant.brandId}, ${PNG_BASE64}, 'image/png', 'poster', 68, 'stored')
  `;
  let extracted = 0;
  const sample = await sampleVideoForJudgment(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, {
    extractor: async (path, timestampMs) => {
      extracted += 1;
      return recordedFrame(path, timestampMs);
    },
  });
  assert.equal(extracted, 0);
  assert.equal(sample.unavailable, "no_stored_container");
  assert.deepEqual(sample.selection, null);
  const measured = await measureVideoFrames(sql, tenant.organizationId, tenant.brandId, sample);
  assert.equal(measured.measuredLogo.outcome, "ABSENT");
  assert.equal(measured.measuredPalette.outcome, "ABSENT");
});

test("the measurements and the visual frames are the same selected frames, and the local record names each one with its timestamp", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "video-frames-same-selection");
  const storageKey = await storedContainer("shared", tenant);
  const sample = await sampleVideoForJudgment(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, { extractor: recordedFrame });
  const chosen = sample.selection?.frames ?? [];
  assert.equal(chosen.length, 3);

  const measured = await measureVideoFrames(sql, tenant.organizationId, tenant.brandId, sample);
  const visual = await videoVisualEvidence(sql, tenant.organizationId, tenant.brandId, storageKey, 3000, { sample: true, sampled: sample });
  assert.deepEqual(visual.media.map((item) => item.id), chosen.map((frame) => frame.id), "the visual questions see the chosen frames, in time order");
  for (const frame of chosen) {
    assert.ok(
      measured.measuredLogo.evidence.includes(`${frame.role} ${frame.id} at ${frame.timestampMs}ms`),
      `the logo measurement names ${frame.id} at ${frame.timestampMs}ms`,
    );
  }
  assert.match(measured.measuredPalette.evidence, new RegExp(FRAME_SELECTION_VERSION.replace(".", "\\.")));

  // The local logo and palette decisions carry the same evidence text, so the record that is written names the version and the frames.
  const decisions = judgeMedia({
    ...videoFacts,
    logoOutcome: measured.measuredLogo.outcome,
    logoSimilarity: measured.measuredLogo.similarity,
    logoEvidence: measured.measuredLogo.evidence,
    paletteOutcome: measured.measuredPalette.outcome,
    paletteDistance: measured.measuredPalette.distance,
    paletteEvidence: measured.measuredPalette.evidence,
  });
  const logo = decisions.find((item) => item.questionId === "logo_match");
  const summaries = (logo?.evidence ?? []).map((item) => item.summary).join(" ");
  assert.match(summaries, new RegExp(FRAME_SELECTION_VERSION.replace(".", "\\.")));
  assert.match(summaries, new RegExp(`${chosen[0]!.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at ${chosen[0]!.timestampMs}ms`));
});
