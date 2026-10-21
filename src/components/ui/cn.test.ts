import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "./cn.ts";

test("a Katana font size is kept next to a text colour", () => {
  assert.equal(cn("text-small text-fg-muted"), "text-small text-fg-muted");
  assert.equal(cn("text-section font-semibold text-fg"), "text-section font-semibold text-fg");
});

test("a later font size replaces an earlier font size, and a later colour replaces an earlier colour", () => {
  assert.equal(cn("text-small", "text-heading"), "text-heading");
  assert.equal(cn("text-fg", "text-accent"), "text-accent");
});
