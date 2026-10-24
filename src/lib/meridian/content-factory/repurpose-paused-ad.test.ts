import assert from "node:assert/strict";
import test from "node:test";
import { pausedAdPreflight } from "./repurpose-paused-ad.ts";

const GOOD = { adSetId: "23851", confirmAdSetId: "23851", pageId: "1020", destinationUrl: "https://example.com/offer", message: "A short message" };

test("a confirmed ad set, a numeric Page and an https link pass the preflight", () => {
  assert.deepEqual(pausedAdPreflight(GOOD), { ok: true });
});

test("a confirmation that does not match the chosen ad set sends nothing", () => {
  const result = pausedAdPreflight({ ...GOOD, confirmAdSetId: "99999" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /Confirm the same ad set/);
});

test("an ad set id that is not numeric is refused", () => {
  assert.equal(pausedAdPreflight({ ...GOOD, adSetId: "act_1", confirmAdSetId: "act_1" }).ok, false);
});

test("a destination that is not an https address is refused, including script and http links", () => {
  for (const destinationUrl of ["http://example.com", "javascript:alert(1)", "not a url", "ftp://example.com/x"]) {
    assert.equal(pausedAdPreflight({ ...GOOD, destinationUrl }).ok, false, destinationUrl);
  }
});

test("a message over 2000 characters is refused before anything is sent", () => {
  assert.equal(pausedAdPreflight({ ...GOOD, message: "x".repeat(2001) }).ok, false);
});
