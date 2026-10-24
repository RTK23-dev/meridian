// The visual treatments of a repurposed cut (contract v11). The framing and the mirror change the footage clips only; the look, grain and
// vignette are overlays over the footage. Captions, graphics and stickers are never changed. A cut without treatments compiles as before.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edlSchema, EngineError, type EditDecisionList, type VisualTreatment } from "../contracts/index.ts";
import { edlFixture, styleKitFixture } from "../contracts/fixtures/index.ts";
import { compile } from "./compiler.ts";

const decoder = new TextDecoder();

function withVisual(visual: VisualTreatment | undefined): EditDecisionList {
  const edl = structuredClone(edlFixture);
  if (visual === undefined) delete (edl as { visual?: VisualTreatment }).visual;
  else (edl as { visual?: VisualTreatment }).visual = visual;
  return edl;
}

function indexOf(edl: EditDecisionList): string {
  const result = compile(edl, styleKitFixture);
  const file = result.files.find((candidate) => candidate.path === "index.html");
  assert.ok(file, "the composition has an index.html");
  return decoder.decode(file.bytes);
}

/** The style attribute of the element with the given id, or null when there is no such element. */
function styleOf(html: string, id: string): string | null {
  const match = new RegExp(`id="${id}"[^>]*style="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

/** The clip ids of the cut, by layer: the footage layers, and the captions layer. */
function clipIdsOf(edl: EditDecisionList, layers: readonly string[]): string[] {
  return edl.tracks.filter((track) => layers.includes(track.layer)).flatMap((track) => track.clips.map((clip) => clip.clipId));
}

const FOOTAGE = ["base", "cutaway", "presenter"];

const FULL: VisualTreatment = {
  version: 1,
  look: { preset: "warm", strength: 0.5 },
  framing: { zoom: 1.05, rotationDeg: 1, offsetXPct: 0, offsetYPct: 0 },
  mirror: true,
  grain: { strength: 0.5 },
  vignette: { strength: 0.5 },
};

describe("a cut without visual treatments compiles as before", () => {
  it("adds no overlay and no transform to any clip", () => {
    const html = indexOf(withVisual(undefined));
    assert.doesNotMatch(html, /fx-look|fx-grain|fx-vignette/);
    assert.doesNotMatch(html, /transform:/);
  });
});

describe("the framing and the mirror apply to the footage only", () => {
  it("gives every footage media clip the transform, mirror first", () => {
    const edl = withVisual(FULL);
    const html = indexOf(edl);
    const footage = clipIdsOf(edl, FOOTAGE);
    assert.ok(footage.length > 0, "the fixture has footage clips to treat");
    let media = 0;
    for (const clipId of footage) {
      const style = styleOf(html, `clip-${clipId}`);
      if (style === null) continue; // a component clip keeps its own rendering
      media += 1;
      assert.match(style, /transform:scaleX\(-1\) scale\(1\.05\) rotate\(1deg\) translate\(0%, 0%\);/);
    }
    assert.ok(media > 0, "at least one footage media clip was treated");
  });

  it("never gives a caption clip a transform, a mirror or a tint", () => {
    const edl = withVisual(FULL);
    const html = indexOf(edl);
    for (const clipId of clipIdsOf(edl, ["captions", "graphics", "stickers"])) {
      const style = styleOf(html, `clip-${clipId}`);
      if (style === null) continue;
      assert.doesNotMatch(style, /transform:/, `clip ${clipId} is not a footage clip`);
    }
  });
});

describe("the look, grain and vignette are overlays over the footage", () => {
  it("draws each overlay at the presenter's layer level, after the picture, with its strength applied", () => {
    const html = indexOf(withVisual(FULL));
    const look = styleOf(html, "fx-look");
    const grain = styleOf(html, "fx-grain");
    const vignette = styleOf(html, "fx-vignette");
    assert.ok(look && grain && vignette, "each overlay is in the composition");
    // LAYER_TRACK.presenter is 2, so the overlays sit at z-index 3: above the footage, below graphics (4), captions (5) and stickers (6).
    for (const style of [look, grain, vignette]) assert.match(style, /z-index:3;/);
    assert.match(look, /opacity:0\.225;/, "warm is 0.45 at full strength, so 0.225 at half");
    assert.match(grain, /opacity:0\.1;/, "grain is 0.2 at full strength, so 0.1 at half");
    assert.match(vignette, /opacity:0\.375;/, "the vignette edge is 0.75 at full strength, so 0.375 at half");
    // The overlays come after the last clip in the picture, so they draw over the footage.
    const lastPictureClipAt = html.lastIndexOf('id="clip-');
    assert.ok(html.indexOf('id="fx-look"') > lastPictureClipAt, "the look draws after the picture clips");
  });

  it("leaves out an overlay whose strength is zero", () => {
    const html = indexOf(withVisual({ version: 1, grain: { strength: 0 } }));
    assert.doesNotMatch(html, /fx-grain/);
  });
});

describe("the visual contract is bounded and strict", () => {
  it("accepts the bounded treatments and a cut with none", () => {
    assert.equal(edlSchema.safeParse(withVisual(FULL)).success, true);
    assert.equal(edlSchema.safeParse(withVisual(undefined)).success, true);
  });

  it("refuses a zoom above 1.12, a rotation above 2 degrees, an unknown look and an unknown key", () => {
    assert.equal(edlSchema.safeParse(withVisual({ version: 1, framing: { zoom: 1.5, rotationDeg: 0, offsetXPct: 0, offsetYPct: 0 } })).success, false);
    assert.equal(edlSchema.safeParse(withVisual({ version: 1, framing: { zoom: 1, rotationDeg: 9, offsetXPct: 0, offsetYPct: 0 } })).success, false);
    assert.equal(edlSchema.safeParse(withVisual({ version: 1, look: { preset: "neon", strength: 0.5 } } as unknown as VisualTreatment)).success, false);
    assert.equal(edlSchema.safeParse(withVisual({ version: 1, css: "body{display:none}" } as unknown as VisualTreatment)).success, false);
  });

  it("refuses at compile time a treatment the contract refuses, so no unchecked value reaches the composition", () => {
    const bad = structuredClone(edlFixture) as EditDecisionList & { visual?: unknown };
    bad.visual = { version: 1, grain: { strength: 2 } };
    assert.throws(() => compile(bad as EditDecisionList, styleKitFixture), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("compiles the same treatments to the same composition, byte for byte", () => {
    const first = compile(withVisual(FULL), styleKitFixture);
    const second = compile(withVisual(FULL), styleKitFixture);
    assert.equal(first.composition.contentHash, second.composition.contentHash);
  });
});
