import assert from "node:assert/strict";
import test from "node:test";
import { providerPromptOf } from "./types.ts";
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

test("a provider prompt keeps spoken copy first and adds visual direction only when one is stored", () => {
  assert.equal(providerPromptOf({ hookLine: "Watch this", script: "It rinses clean." }), "Watch this\nIt rinses clean.");
  assert.equal(
    providerPromptOf({ hookLine: "Watch this", script: "It rinses clean.", visualDirection: "Cut pacing: dynamic." }),
    "Watch this\nIt rinses clean.\n\nVisual direction (do not speak this):\nCut pacing: dynamic.",
  );
  assert.equal(providerPromptOf({ script: "It rinses clean.", visualDirection: "   " }), "It rinses clean.");
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
