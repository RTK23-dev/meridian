import assert from "node:assert/strict";
import test from "node:test";
import { providerLabel, statusLabel } from "./copy.ts";

test("user-facing status and provider labels keep internal values readable", () => {
  assert.equal(statusLabel("NOT_CONNECTED"), "Not connected");
  assert.equal(statusLabel("in_review"), "Needs review");
  assert.equal(providerLabel("test:image"), "Test image");
  assert.equal(providerLabel("google:nano-banana"), "Google Nano Banana");
});
