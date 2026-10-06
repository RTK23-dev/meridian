import assert from "node:assert/strict";
import test from "node:test";
import { studioGenerationSchema } from "./studio-generation.ts";

test("Studio generation accepts only configured image and Hypit video choices", () => {
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "none", videoProvider: "hypit" }).success, true);
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "other", videoProvider: "hypit" }).success, false);
  assert.equal(studioGenerationSchema.safeParse({ imageProvider: "none", videoProvider: "other" }).success, false);
});
