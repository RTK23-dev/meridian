// The Studio's model seats: only a pinned image model with a stated per-image price can be the Studio image model, and only a pinned video
// model with a stated per-second price the Studio video model. Nothing is saved when the catalogue cannot be read.

import assert from "node:assert/strict";
import test from "node:test";
import { eligibleForMediaTask, saveMediaModel, type MediaModelChoice } from "./media-models.ts";

const image: MediaModelChoice = { id: "google/gemini-nano-banana-2.1", name: "Nano Banana 2.1", kind: "image", imageUsd: 0.039, usdPerSecond: null };
const video: MediaModelChoice = { id: "google/veo-3.1", name: "Veo 3.1", kind: "video", imageUsd: null, usdPerSecond: 0.4 };

test("a seat takes only a pinned model of its kind, and a video model only with a stated per-second price", () => {
  assert.deepEqual(eligibleForMediaTask("studio_image", image), { ok: true });
  assert.deepEqual(eligibleForMediaTask("studio_image", { ...image, imageUsd: null }), { ok: true }, "an image's cost is reported after the call");
  assert.deepEqual(eligibleForMediaTask("studio_video", video), { ok: true });
  assert.equal(eligibleForMediaTask("studio_video", { ...video, usdPerSecond: null }).ok, false, "no stated video price, no choice");
  assert.equal(eligibleForMediaTask("studio_image", video).ok, false, "a video model is not an image model");
  assert.equal(eligibleForMediaTask("studio_image", { ...image, id: "openrouter/auto" }).ok, false, "a router is not a model");
  assert.equal(eligibleForMediaTask("studio_image", { ...image, id: "~google/nano-banana-latest" }).ok, false, "an alias is not pinned");
});

test("nothing is saved when the catalogue cannot be read, or the model is not in it", async () => {
  const sql = (() => { throw new Error("no write may happen"); }) as unknown as Parameters<typeof saveMediaModel>[0];
  await assert.rejects(saveMediaModel(sql, { organizationId: "o", task: "studio_image", modelId: image.id, actorId: "u", choices: null }), /could not be read/);
  await assert.rejects(saveMediaModel(sql, { organizationId: "o", task: "studio_image", modelId: "google/unknown", actorId: "u", choices: [image] }), /not in the live catalogue/);
  await assert.rejects(saveMediaModel(sql, { organizationId: "o", task: "studio_image", modelId: video.id, actorId: "u", choices: [image, video] }), /is not an image model/);
});
