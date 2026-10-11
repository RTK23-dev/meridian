import assert from "node:assert/strict";
import test from "node:test";
import { VIDEO_PROVIDER_VALUES } from "../../../components/studio/provider-options.ts";
import { VIDEO_PROVIDER_CHOICES, serverStudioGenerationSchema, studioGenerationSchema } from "./studio-generation.ts";

const base = { imageProvider: "none", videoProvider: "none" } as const;

function videoAccepted(videoProvider: string): boolean {
  return studioGenerationSchema.safeParse({ ...base, videoProvider }).success;
}

test("Studio generation accepts only configured image and Hypit video choices", () => {
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "none", videoProvider: "hypit" }).success, true);
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "other", videoProvider: "hypit" }).success, false);
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "none", videoProvider: "other" }).success, false);
});

test("every video engine the Generate step offers is accepted by the schema", () => {
  for (const value of VIDEO_PROVIDER_VALUES) assert.equal(videoAccepted(value), true, `${value} is offered, so the schema must take it`);
});

test("the schema takes exactly the offered engines plus the two aliases the server maps to google_omni", () => {
  const accepted = [...VIDEO_PROVIDER_CHOICES].sort();
  assert.deepEqual(accepted, [...VIDEO_PROVIDER_VALUES, "auto", "omni"].sort());
  assert.deepEqual([...studioGenerationSchema.shape.videoProvider.options].sort(), accepted);
});

test("the aliases are accepted, and higgsfield and test:video are refused, because no studio run can take them", () => {
  assert.equal(videoAccepted("auto"), true, "the server maps auto to google_omni");
  assert.equal(videoAccepted("omni"), true, "the server maps omni to google_omni");
  assert.equal(videoAccepted("higgsfield"), false, "a studio video targets 8 seconds, outside the Higgsfield model's 5, 10 and 15");
  assert.equal(videoAccepted("test:video"), false, "no test:video provider is registered for a studio run");
  assert.equal(videoAccepted(""), false);
});

test("the server schema adds the brief and brand ids, and still refuses higgsfield", () => {
  const request = { brandId: "brand-a", briefId: "brief-a", imageProvider: "none", videoProvider: "google_omni" };
  assert.equal(serverStudioGenerationSchema.safeParse(request).success, true);
  assert.equal(serverStudioGenerationSchema.safeParse({ ...request, videoProvider: "higgsfield" }).success, false);
  assert.equal(serverStudioGenerationSchema.safeParse({ ...request, briefId: "" }).success, false);
});
