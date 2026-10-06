import assert from "node:assert/strict";
import test from "node:test";
import { observationFieldsSchema } from "./observation.ts";

test("observations trim content and normalize custom tokens and URLs", () => {
  const result = observationFieldsSchema.parse({ origin: "competitor", competitorId: "c-1", angle: "", observedAngle: "  Unboxing / Demo! ", hookType: "Fast start", format: "short UGC", proofType: "visual proof", hook: "  Watch the foam  ", message: "  A plain soap bar  ", sourceUrl: "example.test/ad" });
  assert.equal(result.observedAngle, "unboxing_demo");
  assert.equal(result.hookType, "fast_start");
  assert.equal(result.sourceUrl, "https://example.test/ad");
});

test("observations require the corresponding source and reject unsafe or overlong content", () => {
  assert.equal(observationFieldsSchema.safeParse({ origin: "competitor", competitorId: "", angle: "", hook: "hook", message: "message" }).success, false);
  assert.equal(observationFieldsSchema.safeParse({ origin: "own", angle: "curiosity", hook: " ", message: "message" }).success, false);
  assert.equal(observationFieldsSchema.safeParse({ origin: "own", angle: "curiosity", hook: "hook", message: "message", sourceUrl: "javascript:alert(1)" }).success, false);
});

test("optional observation API fields retain the server's null-as-empty behavior", () => {
  const parsed = observationFieldsSchema.parse({ origin: "own", angle: "curiosity", hook: "Hook", message: "Message", sourceUrl: null, title: null });
  assert.equal(parsed.sourceUrl, "");
  assert.equal(parsed.title, "");
});
