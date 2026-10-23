import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedByFamilies, INITIAL_DISABLED_MODEL_FAMILIES, isDisabledModel, normalizeModelId } from "./model-policy.ts";

test("the initial policy switches Veo off, every version of it", () => {
  assert.deepEqual([...INITIAL_DISABLED_MODEL_FAMILIES], ["google/veo"]);
  assert.equal(isDisabledModel("google/veo-3.1-fast", INITIAL_DISABLED_MODEL_FAMILIES), true);
  assert.equal(isDisabledModel("google/veo-3.1-lite", INITIAL_DISABLED_MODEL_FAMILIES), true);
  assert.equal(isDisabledModel("google/veo", INITIAL_DISABLED_MODEL_FAMILIES), true);
});

test("a family is a prefix: it covers its line and no other vendor's models", () => {
  assert.equal(isDisabledModel("google/gemini-3.8-flash-tts", ["google/veo"]), false);
  assert.equal(isDisabledModel("kwaivgi/kling-v3.0-std", ["google/veo"]), false);
  assert.equal(isDisabledModel("~google/veo-latest", ["google/veo"]), true, "a live alias is still the family");
  assert.equal(isDisabledModel("GOOGLE/VEO-3.1-FAST", ["google/veo"]), true, "matching ignores case");
});

test("with no family switched off, nothing is refused, and an empty family matches nothing", () => {
  assert.equal(isDisabledModel("google/veo-3.1-fast", []), false);
  assert.equal(isDisabledModel("google/veo-3.1-fast", [""]), false);
});

test("allowedByFamilies keeps the entries in their order and drops only the switched-off ones", () => {
  const entries = [{ id: "a/one" }, { id: "google/veo-3.1-lite" }, { id: "b/two" }];
  assert.deepEqual(allowedByFamilies(entries, ["google/veo"]), [{ id: "a/one" }, { id: "b/two" }]);
  assert.deepEqual(allowedByFamilies(entries, []), entries);
});

test("normalizeModelId lowercases and removes a live alias marker", () => {
  assert.equal(normalizeModelId("  ~Google/Veo-3.1 "), "google/veo-3.1");
});
