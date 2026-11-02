import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTION_REASON_MIN, directionReasonSchema } from "./direction-reason.ts";

test("a direction reason is trimmed and must be at least the server's length", () => {
  assert.equal(DIRECTION_REASON_MIN, 20);
  const short = directionReasonSchema.safeParse({ reason: "too short" });
  assert.equal(short.success, false);
  const padded = directionReasonSchema.safeParse({ reason: `   ${"x".repeat(DIRECTION_REASON_MIN - 1)}   ` });
  assert.equal(padded.success, false, "whitespace does not count toward the length");
  const exact = directionReasonSchema.safeParse({ reason: "x".repeat(DIRECTION_REASON_MIN) });
  assert.equal(exact.success, true);
  if (exact.success) assert.equal(exact.data.reason.length, DIRECTION_REASON_MIN);
});
