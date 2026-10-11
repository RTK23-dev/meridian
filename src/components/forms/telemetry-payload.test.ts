import assert from "node:assert/strict";
import test from "node:test";
import { telemetryFormSchema, telemetryPayload, type TelemetryFormFields } from "../learning/telemetry-input.ts";

/** A filled form with only the optional fields blank. Tests change one field at a time from here. */
const filled: TelemetryFormFields = {
  platform: "meta",
  sourceType: "organic",
  creativeId: "",
  views: "1200",
  hookRetention3s: "0.42",
  completionRate: "",
  engagements: "",
  shares: "",
  hookType: "",
  angle: "",
};

test("a blank optional field is left out of the payload, never sent as 0", () => {
  const payload = telemetryPayload(filled);
  assert.equal(payload.completionRate, undefined);
  assert.equal(payload.engagements, undefined);
  assert.equal(payload.shares, undefined);
  assert.equal(payload.creativeId, undefined);
  assert.equal(payload.hookType, undefined);
  assert.equal(payload.angle, undefined);
  assert.equal("completionRate" in payload && payload.completionRate === 0, false);
});

test("required numbers are read with Number(), trimmed first", () => {
  const payload = telemetryPayload({ ...filled, views: " 1200 ", hookRetention3s: "0.42", completionRate: "0.35", shares: "7" });
  assert.equal(payload.views, 1200);
  assert.equal(payload.hookRetention3s, 0.42);
  assert.equal(payload.completionRate, 0.35);
  assert.equal(payload.shares, 7);
});

test("text fields are trimmed, and a blank one is left out", () => {
  const payload = telemetryPayload({ ...filled, platform: " meta ", creativeId: "  variant-9 ", hookType: " question ", angle: "   " });
  assert.equal(payload.platform, "meta");
  assert.equal(payload.creativeId, "variant-9");
  assert.equal(payload.hookType, "question");
  assert.equal(payload.angle, undefined);
});

test("a blank required number is refused as required, and a non-number as not a number", () => {
  const blank = telemetryFormSchema.safeParse({ ...filled, views: "  " });
  assert.equal(blank.success, false);
  if (!blank.success) assert.equal(blank.error.issues[0]?.message, "Views is required.");
  const text = telemetryFormSchema.safeParse({ ...filled, hookRetention3s: "lots" });
  assert.equal(text.success, false);
  if (!text.success) assert.equal(text.error.issues[0]?.message, "3s hook retention must be a number.");
});

test("an optional number is allowed blank, but a typed non-number is refused", () => {
  assert.equal(telemetryFormSchema.safeParse(filled).success, true);
  const typed = telemetryFormSchema.safeParse({ ...filled, completionRate: "half" });
  assert.equal(typed.success, false);
  if (!typed.success) assert.equal(typed.error.issues[0]?.message, "Completion rate must be a number.");
});

test("the platform and the source type are required", () => {
  assert.equal(telemetryFormSchema.safeParse({ ...filled, platform: "  " }).success, false);
  assert.equal(telemetryFormSchema.safeParse({ ...filled, sourceType: "billboard" as TelemetryFormFields["sourceType"] }).success, false);
});
