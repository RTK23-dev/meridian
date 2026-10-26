import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarizeRun } from "./run-summary.ts";
import type { SourceRunState } from "./types.ts";

const ran = (seenBefore: number, itemsFound = 0): SourceRunState => ({ adapterId: "website", seed: "https://shop.example/p", status: "ran", itemsFound, seenBefore, sourceStatus: "HEALTHY" });
const failed = (reason: string): SourceRunState => ({ adapterId: "website", seed: "https://social.example/p", status: "failed", reason });
const notSupported = (adapterId: string): SourceRunState => ({ adapterId, seed: "https://shop.example/p", status: "not_supported", reason: "names a page" });

describe("a discovery run in plain words", () => {
  test("new evidence is the only outcome that says examples were stored", () => {
    const summary = summarizeRun({ discoveredUrls: 3, seenBefore: 2, sources: [ran(2, 3)] });
    assert.equal(summary.outcome, "new_evidence");
    assert.match(summary.headline, /3 new examples stored, 2 already stored/);
  });

  test("a duplicate-only run says nothing new was added", () => {
    const summary = summarizeRun({ discoveredUrls: 0, seenBefore: 5, sources: [ran(5)] });
    assert.equal(summary.outcome, "nothing_new");
    assert.match(summary.headline, /Nothing new/);
    assert.doesNotMatch(summary.headline, /new examples? stored/);
    assert.equal(summary.stored, 0);
  });

  test("a robots.txt refusal is blocked, is not worked around, and offers a supported way on", () => {
    const reason = "This site's robots.txt does not allow MeridianBot to read this page, so the page was not read.";
    const summary = summarizeRun({ discoveredUrls: 0, seenBefore: 0, sources: [failed(reason)] });
    assert.equal(summary.outcome, "blocked");
    assert.equal(summary.blocker, reason);
    assert.match(summary.nextStep ?? "", /upload|paste/i);
  });

  test("sources that were never used for this input are counted as not used, never as failures", () => {
    const summary = summarizeRun({ discoveredUrls: 0, seenBefore: 5, sources: [ran(5), notSupported("youtube"), notSupported("tiktok"), notSupported("meta_ad_library")] });
    assert.equal(summary.failed, 0);
    assert.equal(summary.notUsed, 3);
    assert.equal(summary.blocker, null);
  });

  test("stored items plus a failed source is partial, not a clean success", () => {
    const summary = summarizeRun({ discoveredUrls: 1, seenBefore: 0, sources: [ran(0, 1), failed("timed out")] });
    assert.equal(summary.outcome, "partial");
  });

  test("a run where nothing ran is not described as completed", () => {
    const summary = summarizeRun({ discoveredUrls: 0, seenBefore: 0, sources: [notSupported("youtube")] });
    assert.equal(summary.outcome, "nothing_ran");
  });
});

test("a blocked social URL names the platform, says there is no connector, and never asks for a key", () => {
  const summary = summarizeRun({ discoveredUrls: 0, seenBefore: 0, seeds: ["https://www.instagram.com/p/abc/"], sources: [failed("This site's robots.txt does not allow MeridianBot to read this page, so the page was not read.")] });
  assert.equal(summary.outcome, "blocked");
  assert.match(summary.headline, /Instagram did not let Meridian read/);
  assert.match(summary.nextStep ?? "", /no connector in this release/);
  assert.match(summary.nextStep ?? "", /Upload the post or paste its text/);
  assert.doesNotMatch(`${summary.headline} ${summary.nextStep}`, /add a key|save a key/i);
});
