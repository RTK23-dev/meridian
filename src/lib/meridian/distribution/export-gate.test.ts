import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateForCreative, manifestForCreative, plainReasons } from "./export-gate.ts";

describe("the export disclosure check", () => {
  it("treats a creative Meridian made as generated, so it needs the AI label and provenance record", () => {
    const manifest = manifestForCreative("creative-1");
    assert.equal(manifest.hasGenerativeVideoShots, true);
    assert.equal(manifest.hasSyntheticFacesOrVoices, true);
  });

  it("blocks the export and says why, in plain words, until the disclosures exist", () => {
    const result = gateForCreative("creative-1");
    assert.equal(result.passed, false);
    const reasons = plainReasons(result);
    assert.equal(reasons.length, 3);
    assert.ok(reasons.some((reason) => reason.includes("no visible AI label")));
    assert.ok(reasons.some((reason) => reason.includes("C2PA provenance record")));
    assert.ok(reasons.some((reason) => reason.includes("AI-generated")));
  });

  it("never drops a violation it does not know, and shows it as it is", () => {
    const reasons = plainReasons({ passed: false, requiresAiLabel: true, requiresSponsorTag: false, violations: ["NEW_RULE: something"] });
    assert.deepEqual(reasons, ["NEW_RULE: something"]);
  });

  it("passes with no reasons when nothing is required", () => {
    const reasons = plainReasons({ passed: true, requiresAiLabel: false, requiresSponsorTag: false, violations: [] });
    assert.deepEqual(reasons, []);
  });
});
