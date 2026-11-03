import assert from "node:assert/strict";
import { test } from "node:test";
import { plainErrorText } from "./error-text.ts";

test("keys are removed, whitespace is folded and the text is shortened", () => {
  const text = plainErrorText(new Error(`upstream said:\n  Bearer abc123secret   and sk-or-v1-abcdef ${"x".repeat(500)}`), "none");
  assert.ok(!text.includes("abc123secret"));
  assert.ok(!text.includes("sk-or-v1-abcdef"));
  assert.ok(!text.includes("\n"));
  assert.ok(text.length <= 300);
});

test("a non-error or an empty message gives the fallback", () => {
  assert.equal(plainErrorText("boom", "fallback"), "fallback");
  assert.equal(plainErrorText(new Error("  "), "fallback"), "fallback");
});
