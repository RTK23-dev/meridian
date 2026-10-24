// A repurposed child cut against its master (contract v11): the diff names only the treatment surface, the control accepts that and refuses
// anything else, and the child's id is stable for a variation and distinct between variations.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edlFixture } from "../contracts/fixtures/index.ts";
import { edlSchema, type VisualTreatment } from "../contracts/index.ts";
import { repurposedEdl } from "./child.ts";
import { diffEdl, checkRepurposeControl } from "../variants/diff.ts";

const visualTreatmentFixtureForRepurpose: VisualTreatment = {
  version: 1,
  look: { preset: "cool", strength: 0.5 },
  framing: { zoom: 1.04, rotationDeg: 0, offsetXPct: 0, offsetYPct: 0 },
  mirror: true,
  grain: { strength: 0.2 },
  vignette: { strength: 0.3 },
};

describe("a repurposed child differs from its master only in its treatment", () => {
  it("names one treatment change and nothing else", () => {
    const child = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    const changes = diffEdl(edlFixture, child);
    assert.deepEqual(changes, [{ surface: "treatment", path: "visual" }]);
  });

  it("is accepted by the repurpose control", () => {
    const child = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    assert.deepEqual(checkRepurposeControl(diffEdl(edlFixture, child)), { pass: true, violations: [] });
  });

  it("records its master, and parses as an EDL", () => {
    const child = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    assert.equal(child.variantOf, edlFixture.edlId);
    assert.equal(edlSchema.safeParse(child).success, true);
    assert.notEqual(child.edlId, edlFixture.edlId, "the child has its own id");
  });

  it("keeps the same id for the same variation, and a different one for another variation", () => {
    const a1 = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    const a2 = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    const b = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_b");
    assert.equal(a1.edlId, a2.edlId);
    assert.notEqual(a1.edlId, b.edlId);
  });

  it("is refused by the control when it also moves a caption or the timing", () => {
    const child = repurposedEdl(edlFixture, visualTreatmentFixtureForRepurpose, "key_a");
    const moved = structuredClone(child);
    moved.tracks = moved.tracks.map((track) =>
      track.layer === "captions" ? { ...track, clips: track.clips.map((clip) => ({ ...clip, endMs: clip.endMs + 100 })) } : track,
    );
    const check = checkRepurposeControl(diffEdl(edlFixture, moved));
    assert.equal(check.pass, false);
    assert.deepEqual(check.violations, ["captions (tracks.captions)"], "the caption track is named, and only the treatment may change");
  });

  it("is refused when nothing changed, because the cut is then the master", () => {
    assert.equal(checkRepurposeControl(diffEdl(edlFixture, edlFixture)).pass, false);
  });
});
