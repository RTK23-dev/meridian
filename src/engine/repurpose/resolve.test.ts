// The repurpose resolver: off by default, one option per enabled category per variation, reproducible from the source, the request and the
// settings, no two variations alike, bounded in count, refused when a control has no effect, and always a valid visual treatment.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visualTreatmentSchema } from "../contracts/index.ts";
import { CATEGORY_LABELS, MAX_REPURPOSE_VARIANTS, REPURPOSE_CATEGORIES, UNAVAILABLE_CAPABILITIES } from "./catalog.ts";
import { defaultRepurposeSettings, resolveRepurpose, type RepurposeSettings } from "./resolve.ts";

const SOURCE = "edl_source_master_0001";
const REQUEST = "req_01HZRESOLVE000000000000000";

function on(overrides: Partial<RepurposeSettings> = {}): RepurposeSettings {
  return { ...defaultRepurposeSettings(), enabled: true, ...overrides };
}

function resolved(settings: unknown, requestId = REQUEST) {
  const outcome = resolveRepurpose({ settings, sourceEdlId: SOURCE, requestId });
  assert.equal(outcome.status, "resolved", outcome.status === "refused" ? outcome.reasons.join(" / ") : "");
  if (outcome.status !== "resolved") throw new Error("unreachable");
  return outcome;
}

describe("the feature is off unless it is enabled", () => {
  it("makes nothing from the default settings", () => {
    assert.deepEqual(resolveRepurpose({ settings: defaultRepurposeSettings(), sourceEdlId: SOURCE, requestId: REQUEST }), { status: "off" });
  });

  it("starts moderate, with three variations, and every applicable category on", () => {
    const defaults = defaultRepurposeSettings();
    assert.equal(defaults.intensity, 3);
    assert.equal(defaults.variantCount, 3);
    assert.equal(defaults.categories.text_overlay.enabled, false, "text overlays cannot be applied, so they start off");
    assert.equal(defaults.categories.warp_rotation.enabled, true);
    assert.equal(defaults.categories.color_look.options.length, 4);
  });
});

describe("the variations", () => {
  it("take exactly one option from each enabled category, and none from a category that is off", () => {
    const outcome = resolved(on());
    assert.equal(outcome.variations.length, 3);
    for (const variation of outcome.variations) {
      const categories = variation.treatments.map((treatment) => treatment.category);
      assert.deepEqual(categories, ["warp_rotation", "color_look", "frame_mirror", "texture_grain", "lighting"]);
      assert.equal(categories.includes("text_overlay"), false);
    }
  });

  it("are distinct: no two variations share a combination of options", () => {
    const outcome = resolved(on({ variantCount: MAX_REPURPOSE_VARIANTS }));
    const combinations = new Set(outcome.variations.map((variation) => variation.treatments.map((treatment) => treatment.optionId).join("|")));
    assert.equal(combinations.size, outcome.variations.length);
    assert.equal(new Set(outcome.variations.map((variation) => variation.key)).size, outcome.variations.length);
  });

  it("are reproducible: the same source, request and settings name the same variations and seeds, so a retry makes the same ones", () => {
    const first = resolved(on());
    const second = resolved(on());
    assert.deepEqual(first.variations, second.variations);
  });

  it("change with the request, so a second repurpose of the same source is not a copy of the first", () => {
    const first = resolved(on(), REQUEST);
    const other = resolved(on(), "req_01HZRESOLVE000000000000001");
    assert.notDeepEqual(
      first.variations.map((variation) => variation.key),
      other.variations.map((variation) => variation.key),
    );
  });

  it("carry a visual treatment the contract accepts, with each variation's choices recorded", () => {
    const outcome = resolved(on({ variantCount: 8 }));
    for (const variation of outcome.variations) {
      assert.equal(visualTreatmentSchema.safeParse(variation.visual).success, true);
      assert.equal(variation.treatments.length, 5);
      assert.equal(typeof variation.seed, "number");
    }
  });
});

describe("the count is bounded", () => {
  it("refuses a count of zero or above the maximum, and a count that is not a whole number", () => {
    for (const variantCount of [0, MAX_REPURPOSE_VARIANTS + 1, 2.5]) {
      const outcome = resolveRepurpose({ settings: on({ variantCount }), sourceEdlId: SOURCE, requestId: REQUEST });
      assert.equal(outcome.status, "refused", `variantCount ${variantCount}`);
    }
  });

  it("makes fewer variations than asked when the chosen options allow no more, and says why", () => {
    const outcome = resolved(
      on({
        variantCount: 8,
        categories: {
          ...defaultRepurposeSettings().categories,
          warp_rotation: { enabled: true, options: ["zoom_in"] },
          color_look: { enabled: true, options: ["warm"] },
          frame_mirror: { enabled: false, options: [] },
          texture_grain: { enabled: false, options: [] },
          lighting: { enabled: false, options: [] },
        },
      }),
    );
    assert.equal(outcome.variations.length, 1);
    assert.match(outcome.reasons[0] ?? "", /Only 1 distinct combination/);
  });
});

describe("the pool is narrowed by the options the person chooses", () => {
  it("uses only the chosen options of a category", () => {
    const outcome = resolved(
      on({
        variantCount: 4,
        categories: { ...defaultRepurposeSettings().categories, color_look: { enabled: true, options: ["warm", "mono"] } },
      }),
    );
    for (const variation of outcome.variations) {
      const look = variation.treatments.find((treatment) => treatment.category === "color_look");
      assert.ok(look?.optionId === "warm" || look?.optionId === "mono", `the look ${look?.optionId} was not chosen`);
    }
  });
});

describe("the intensity scales the treatments", () => {
  it("applies more grain at a higher intensity, for the same options", () => {
    const grainAt = (intensity: number) => {
      const outcome = resolved(
        on({
          intensity,
          variantCount: 1,
          categories: {
            ...defaultRepurposeSettings().categories,
            warp_rotation: { enabled: false, options: [] },
            color_look: { enabled: false, options: [] },
            frame_mirror: { enabled: false, options: [] },
            lighting: { enabled: false, options: [] },
            texture_grain: { enabled: true, options: ["grain_fine"] },
          },
        }),
      );
      return outcome.variations[0]?.visual.grain?.strength ?? -1;
    };
    assert.ok(grainAt(1) < grainAt(3), "level 1 is lighter than level 3");
    assert.ok(grainAt(3) < grainAt(5), "level 3 is lighter than level 5");
    assert.equal(grainAt(5), 1, "the full scale applies the option at its full strength");
  });
});

describe("a control that cannot apply is refused, not ignored", () => {
  it("refuses a category that is on with no option chosen", () => {
    const outcome = resolveRepurpose({
      settings: on({ categories: { ...defaultRepurposeSettings().categories, lighting: { enabled: true, options: [] } } }),
      sourceEdlId: SOURCE,
      requestId: REQUEST,
    });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join(" "), new RegExp(CATEGORY_LABELS.lighting));
  });

  it("refuses text overlays, which have no applicable option in this release", () => {
    const outcome = resolveRepurpose({
      settings: on({ categories: { ...defaultRepurposeSettings().categories, text_overlay: { enabled: true, options: ["text_style"] } } }),
      sourceEdlId: SOURCE,
      requestId: REQUEST,
    });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join(" "), /no option in it can be applied/);
  });

  it("refuses an option name that is not in its category", () => {
    const outcome = resolveRepurpose({
      settings: on({ categories: { ...defaultRepurposeSettings().categories, color_look: { enabled: true, options: ["zoom_in"] } } }),
      sourceEdlId: SOURCE,
      requestId: REQUEST,
    });
    assert.equal(outcome.status, "refused");
  });

  it("refuses when every category is off, and an unknown key, and a bad intensity", () => {
    const allOff = defaultRepurposeSettings();
    for (const category of REPURPOSE_CATEGORIES) allOff.categories[category] = { enabled: false, options: [] };
    assert.equal(resolveRepurpose({ settings: { ...allOff, enabled: true }, sourceEdlId: SOURCE, requestId: REQUEST }).status, "refused");
    assert.equal(resolveRepurpose({ settings: { ...on(), css: "x" }, sourceEdlId: SOURCE, requestId: REQUEST }).status, "refused");
    assert.equal(resolveRepurpose({ settings: on({ intensity: 9 }), sourceEdlId: SOURCE, requestId: REQUEST }).status, "refused");
  });
});

describe("what Meridian does not offer", () => {
  it("lists templates and packs as unavailable, each with its reason", () => {
    assert.deepEqual(
      UNAVAILABLE_CAPABILITIES.map((capability) => capability.id),
      ["templates", "packs"],
    );
    for (const capability of UNAVAILABLE_CAPABILITIES) assert.ok(capability.reason.length > 20);
  });
});
