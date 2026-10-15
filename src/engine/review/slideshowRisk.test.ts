import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../config/thresholds.ts";
import { REVIEW_TUNING } from "./tuning.ts";
import type { ScriptBeat, ShotSpec, VisualType } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { slideshowDimensions, slideshowRisk, weightedMean, type SlideshowInput } from "./slideshowRisk.ts";

type SourceOf = ShotSpec["source"];

function shot(n: number, beatId: string, visualType: VisualType, source: SourceOf, options: { startMs?: number; mustSatisfy?: string } = {}): ShotSpec {
  const start = options.startMs ?? (n - 1) * 3000;
  return {
    shotId: fixtureId("shot_", n),
    beatId,
    startMs: start,
    endMs: start + 3000,
    visualType,
    layer: visualType === "ugc_presenter" ? "presenter" : "base",
    source,
    ...(options.mustSatisfy === undefined ? {} : { mustSatisfy: options.mustSatisfy }),
  } as ShotSpec;
}

/** A coded shot: a component, the way coded_graphics and kinetic_type are drawn. */
function coded(n: number, beatId: string, visualType: VisualType = "coded_graphics", component = "list.tierBoard", text = "tier board of blenders"): ShotSpec {
  return shot(n, beatId, visualType, { kind: "component", component, props: { title: text } });
}

/** A moving presenter-free shot: a video generation whose prompt says what it shows. */
function moving(n: number, beatId: string, prompt = "a blender blends a fruit smoothie on a kitchen counter"): ShotSpec {
  return shot(n, beatId, "product_hero", { kind: "generate", modelClass: "video.budget", prompt, refs: [], takes: 1 });
}

function beat(beatId: string, text: string): ScriptBeat {
  return { beatId, role: "item", text };
}

const BEATS: ScriptBeat[] = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((id, index) =>
  beat(id, index % 2 === 0 ? "the tier board ranks every blender on the counter" : "a smoothie blends fruit on the kitchen counter"),
);

function input(shots: ShotSpec[], overrides: Partial<SlideshowInput> = {}): SlideshowInput {
  return { shots, edl: { effects: [] }, beats: BEATS, ...overrides };
}

describe("slideshow risk: the coded run (Bible 12.3 acceptance: five coded shots in a row is blocked)", () => {
  it("five coded shots in a row are blocked, and every one of them is named", () => {
    const shots = [1, 2, 3, 4, 5].map((n) => coded(n, "b1"));
    const result = slideshowRisk(input(shots));
    const check = result.checks.find((item) => item.rule === "slideshow_coded_run");
    assert.equal(check?.pass, false);
    assert.equal(check?.value, 5);
    assert.equal(check?.limit, REVIEW_TUNING.codedRunMax);
    assert.deepEqual([...result.failingShotIds].sort(), shots.map((item) => item.shotId).sort());
  });

  it("four coded shots in a row are the longest run that passes (the limit is one below the blocked five)", () => {
    const result = slideshowRisk(input([1, 2, 3, 4].map((n) => coded(n, "b1"))));
    assert.equal(result.checks.find((item) => item.rule === "slideshow_coded_run")?.pass, true);
    assert.equal(result.codedRun.longest, 4);
    assert.equal(REVIEW_TUNING.codedRunMax, 4);
  });

  it("a moving shot between coded shots breaks the run, so five coded shots split 2 and 3 pass", () => {
    const shots = [coded(1, "b1"), coded(2, "b1"), moving(3, "b2"), coded(4, "b3"), coded(5, "b3"), coded(6, "b4")];
    const result = slideshowRisk(input(shots));
    assert.equal(result.checks.find((item) => item.rule === "slideshow_coded_run")?.pass, true);
    assert.equal(result.codedRun.longest, 3);
  });

  it("a presenter shot breaks a run of shot types, but not the coded run", () => {
    const presenter = shot(3, "b2", "ugc_presenter", { kind: "generate", modelClass: "avatar", prompt: "a presenter says the line", refs: [], takes: 1 });
    const shots = [coded(1, "b1"), coded(2, "b1"), presenter, coded(4, "b3"), coded(5, "b3")];
    const result = slideshowRisk(input(shots));
    assert.equal(result.codedRun.longest, 2);
    assert.equal(result.checks.find((item) => item.rule === "slideshow_coded_run")?.pass, true);
  });

  it("the repetition dimension rises with a long run of one shot type (Bible 8.3 limit on the same type)", () => {
    const shots = [1, 2, 3, 4, 5].map((n) => coded(n, "b1", "kinetic_type", "kinetic.punchline"));
    const repetition = slideshowDimensions(input(shots)).find((item) => item.dimension === "repetition");
    assert.equal(repetition?.value, 1);
    assert.equal(repetition?.shotIds.length, 5);
  });
});

describe("slideshow risk: the six dimensions and the weighted mean (Bible 12.3)", () => {
  it("a varied plan that illustrates its beats and moves passes the mean", () => {
    const shots = [moving(1, "b1"), moving(2, "b2"), coded(3, "b3"), moving(4, "b4"), moving(5, "b5"), moving(6, "b6")];
    const result = slideshowRisk(input(shots));
    assert.equal(result.checks.find((item) => item.rule === "slideshow_risk_below_max")?.pass, true);
    assert.ok((result.mean ?? 1) < thresholds.postRender.slideshowRiskMax.value);
  });

  it("a plan of still images on cinematic and stock claims fails the mean", () => {
    const stills = [1, 2, 3, 4, 5, 6].map((n) =>
      shot(n, `b${n}`, "cinematic", { kind: "asset", assetUri: `store://stills/${n}.png` }),
    );
    const result = slideshowRisk(input(stills));
    const unsupported = result.dimensions.find((item) => item.dimension === "unsupported_cinematic_claims");
    const weak = result.dimensions.find((item) => item.dimension === "weak_motion");
    assert.equal(unsupported?.value, 1, "every cinematic shot has a still source");
    assert.equal(weak?.value, 1, "every shot is still with no motion effect");
    assert.equal(result.checks.find((item) => item.rule === "slideshow_risk_below_max")?.pass, false);
    assert.ok(result.failingShotIds.length > 0);
  });

  it("a motion effect inside a still shot takes it out of the weak-motion dimension", () => {
    const still = shot(1, "b1", "stock_footage", { kind: "asset", assetUri: "store://stills/1.png" });
    const without = slideshowDimensions(input([still])).find((item) => item.dimension === "weak_motion");
    const withEffect = slideshowDimensions({
      shots: [still],
      edl: { effects: [{ atMs: 500, kind: "punch_in", params: { scale: 1.1 } }] },
      beats: BEATS,
    }).find((item) => item.dimension === "weak_motion");
    assert.equal(without?.value, 1);
    assert.equal(withEffect?.value, 0);
  });

  it("decorative visuals: a shot with no word in common with its beat and no must request is decorative", () => {
    const unrelated = shot(1, "b1", "product_hero", {
      kind: "generate",
      modelClass: "video.budget",
      prompt: "a quiet mountain lake at dawn with mist",
      refs: [],
      takes: 1,
    });
    const linked = moving(2, "b2", "smoothie fruit blends on the counter");
    const decorative = slideshowDimensions(input([unrelated, linked])).find((item) => item.dimension === "decorative_visuals");
    assert.deepEqual(decorative?.shotIds, [unrelated.shotId]);
    assert.equal(decorative?.value, 0.5);
  });

  it("a must request counts as the shot's purpose, so the shot is not decorative", () => {
    const unrelated = shot(1, "b1", "product_hero", {
      kind: "generate",
      modelClass: "video.budget",
      prompt: "a quiet mountain lake at dawn with mist",
      refs: [],
      takes: 1,
    }, { mustSatisfy: "the blender on a clean kitchen counter" });
    const decorative = slideshowDimensions(input([unrelated])).find((item) => item.dimension === "decorative_visuals");
    assert.equal(decorative?.value, 0);
  });

  it("shot intent: a shot whose beat is not in the script has no stated purpose", () => {
    const orphan = moving(1, "b-not-in-script");
    const intent = slideshowDimensions(input([orphan, moving(2, "b2")])).find((item) => item.dimension === "shot_intent");
    assert.equal(intent?.value, 0.5);
    assert.deepEqual(intent?.shotIds, [orphan.shotId]);
  });

  it("typography over-reliance: the share of time in text-led shots", () => {
    const text = shot(1, "b1", "kinetic_type", { kind: "component", component: "kinetic.punchline", props: { lines: ["never again"] } });
    const picture = moving(2, "b2");
    const typography = slideshowDimensions(input([text, picture])).find((item) => item.dimension === "typography_over_reliance");
    assert.equal(typography?.value, 0.5);
  });

  it("the weighted mean is the mean of the six values with the configured weights", () => {
    const dimensions = slideshowDimensions(input([moving(1, "b1"), moving(2, "b2")]));
    const mean = weightedMean(dimensions);
    const expected = dimensions.reduce((sum, item) => sum + item.value, 0) / dimensions.length;
    assert.ok(mean !== null && Math.abs(mean - expected) < 0.001);
  });

  it("no shots: the mean is unknown, and the mean check is not evaluated (missing evidence is never a pass)", () => {
    const result = slideshowRisk(input([]));
    assert.equal(result.mean, null);
    const check = result.checks.find((item) => item.rule === "slideshow_risk_below_max");
    assert.equal(check?.pass, false);
    assert.match(check?.detail ?? "", /not evaluated/);
    assert.equal(result.checks.find((item) => item.rule === "slideshow_coded_run")?.pass, true, "an empty plan has no coded run");
  });

  it("the dimension values are between 0 and 1", () => {
    const shots = [coded(1, "b1"), coded(2, "b1"), moving(3, "b9"), shot(4, "b2", "cinematic", { kind: "asset", assetUri: "store://x.png" })];
    for (const item of slideshowDimensions(input(shots))) {
      assert.ok(item.value >= 0 && item.value <= 1, `${item.dimension} is ${item.value}`);
    }
  });
});
