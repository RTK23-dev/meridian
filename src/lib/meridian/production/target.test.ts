import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductionTarget } from "./target.ts";

test("production target accepts a registered compatible provider/model pair", () => {
  assert.deepEqual(resolveProductionTarget({
    provider: "google_omni",
    model: "gemini-omni-1.1-flash",
    capability: "VIDEO_GENERATION",
    aspectRatio: "9:16",
    durationSeconds: 8,
  }), { provider: "google_omni", model: "gemini-omni-1.1-flash" });
});

test("production target rejects cross-provider and unsupported capability combinations", () => {
  assert.throws(() => resolveProductionTarget({
    provider: "google_omni", model: "higgsfield-video-v1", capability: "VIDEO_GENERATION",
  }), /belongs to 'higgsfield'/);
  assert.throws(() => resolveProductionTarget({
    provider: "google_omni", model: "gemini-omni-1.1-flash", capability: "VIDEO_GENERATION", aspectRatio: "4:5",
  }), /does not support aspect ratio/);
});

test("production target rejects unsupported model duration", () => {
  assert.throws(() => resolveProductionTarget({
    provider: "google_omni",
    model: "gemini-omni-1.1-flash",
    capability: "VIDEO_GENERATION",
    aspectRatio: "9:16",
    durationSeconds: 12,
  }), /does not support 12-second output/);
});
