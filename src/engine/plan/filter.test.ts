import assert from "node:assert/strict";
import test from "node:test";
import { VISUAL_TYPES, type VisualType } from "../contracts/index.ts";
import { filterCandidates, mustAllowedTypes, type FilterInput } from "./filter.ts";
import { PROPERTY_TYPES } from "./tables.ts";
import type { Candidate, PlanKits } from "./types.ts";

const ALL_KITS: PlanKits = { persona: true, rigCharacter: true, generatedCharacter: true, productKit: true };

function pool(types: readonly VisualType[]): Candidate[] {
  return types.map((visualType, index) => ({ visualType, origin: "proposal" as const, proposalIndex: index }));
}

function base(overrides: Partial<FilterInput>): FilterInput {
  return {
    candidates: pool(VISUAL_TYPES),
    kits: ALL_KITS,
    remainingUsd: 100,
    durationMs: 3000,
    mustAllowed: null,
    showsProduct: false,
    textInPixels: false,
    handsOnProduct: false,
    ...overrides,
  };
}

function keptTypes(input: FilterInput): VisualType[] {
  return filterCandidates(input).kept.map((item) => item.visualType);
}

function rejectedBy(input: FilterInput, rule: string): VisualType[] {
  return filterCandidates(input)
    .rejected.filter((item) => item.rule === rule)
    .map((item) => item.visualType);
}

test("rule 1: a must keeps only the types it allows", () => {
  const allowed = mustAllowedTypes([{ strength: "must", want: "the blender", properties: ["real_product"] }]) ?? [];
  assert.deepEqual(allowed, ["product_hero", "cinematic", "coded_graphics", "stop_motion"], "in VISUAL_TYPES order");
  const input = base({ mustAllowed: allowed, showsProduct: true });
  assert.ok(rejectedBy(input, "rule1_must").includes("stock_footage"));
  assert.ok(rejectedBy(input, "rule1_must").includes("ugc_presenter"));
  assert.deepEqual(
    keptTypes(input).filter((type) => allowed.includes(type)).sort(),
    keptTypes(input).sort(),
    "everything kept is allowed by the must",
  );
});

test("mustAllowedTypes: several properties intersect, several musts intersect, and no property allows nothing", () => {
  assert.deepEqual(mustAllowedTypes([]), null, "no must means no restriction");
  assert.deepEqual(
    mustAllowedTypes([{ strength: "must", want: "a", properties: ["person_talking", "real_product"] }]),
    [],
    "no type shows a person and the product together",
  );
  assert.deepEqual(
    mustAllowedTypes([{ strength: "must", want: "a", properties: ["real_product", "real_world_context"] }]),
    ["cinematic"],
    "only cinematic does both",
  );
  assert.deepEqual(mustAllowedTypes([{ strength: "must", want: "a", properties: [] }]), [], "an unclassified must allows nothing");
  const twoMusts = mustAllowedTypes([
    { strength: "must", want: "a", properties: ["real_product"] },
    { strength: "must", want: "b", properties: ["text_led"] },
  ]);
  assert.deepEqual(twoMusts, ["coded_graphics"]);
  assert.deepEqual(
    mustAllowedTypes([{ strength: "may", want: "c", properties: ["real_product"] }]),
    null,
    "a may request does not restrict",
  );
});

test("the property table is complete: every property names at least one type", () => {
  for (const [property, types] of Object.entries(PROPERTY_TYPES)) {
    assert.ok(types.length > 0, `${property} maps to types`);
  }
});

test("rule 2: a product shot never generates the product without a pinned hero image", () => {
  const withProduct = base({ showsProduct: true });
  assert.ok(rejectedBy(withProduct, "rule2_product_pixels").includes("cartoon_generated"));
  assert.ok(rejectedBy(withProduct, "rule2_product_pixels").includes("cinematic") === false, "cinematic is kept when pinned");
  const unpinned = base({ showsProduct: true, kits: { ...ALL_KITS, productKit: false } });
  assert.ok(rejectedBy(unpinned, "rule2_product_pixels").includes("cinematic"), "cinematic needs a pinned frame");
  assert.ok(!rejectedBy(base({ showsProduct: false }), "rule2_product_pixels").includes("cinematic"), "no product, no rule");
});

test("rule 3: legible text never sits in generated pixels; non-generated types stay", () => {
  const input = base({ textInPixels: true });
  const kept = keptTypes(input);
  for (const type of ["ugc_presenter", "product_hero", "cinematic", "cartoon_generated", "react_clip", "stop_motion"] as const) {
    assert.ok(!kept.includes(type), `${type} is removed`);
    assert.ok(rejectedBy(input, "rule3_text_in_pixels").includes(type));
  }
  assert.ok(kept.includes("stock_footage"));
  assert.ok(kept.includes("coded_graphics"));
  assert.ok(kept.includes("kinetic_type"));
});

test("rule 4: hands on the product are never generated", () => {
  const input = base({ handsOnProduct: true });
  const kept = keptTypes(input);
  assert.ok(!kept.includes("product_hero"));
  assert.ok(!kept.includes("ugc_presenter"));
  assert.ok(rejectedBy(input, "rule4_hands_on_product").includes("cinematic"));
  assert.ok(kept.includes("stock_footage"));
  assert.ok(kept.includes("screen_mock"), "screen_mock is a component (no generated pixels), so rule 4 does not touch it");
  assert.ok(kept.includes("cartoon_rigged"), "cartoon_rigged is a component too, and the page has its rig");
});

test("rule 5: a candidate costlier than the remaining budget is removed, a zero-cost one is kept at zero remaining", () => {
  // Cinematic at 4 s costs 0.126 x 4 x 2 = 1.008, plus the 25% allowance = 1.26.
  const tight = base({ remainingUsd: 1, durationMs: 4000 });
  assert.ok(rejectedBy(tight, "rule5_budget").includes("cinematic"));
  assert.ok(keptTypes(tight).includes("product_hero") === true, "product_hero (0.1344 x 1.25 at 4 s) fits");
  const none = base({ remainingUsd: 0 });
  const kept = keptTypes(none);
  assert.ok(kept.includes("coded_graphics"), "a zero-cost type is never removed for budget");
  assert.ok(kept.includes("stock_footage"));
  assert.ok(!kept.includes("ugc_presenter"));
});

test("rule 6 names the build gaps that remain, and a gap is not a kit", () => {
  const details = filterCandidates(base({})).rejected.filter((item) => item.rule === "rule6_kit");
  const gapOf = (type: VisualType) => details.find((item) => item.visualType === type)?.detail ?? "";
  assert.match(gapOf("react_clip"), /no source can be built for it yet/);
  assert.match(gapOf("cartoon_generated"), /no source can be built for it yet/);
  assert.doesNotMatch(gapOf("cartoon_generated"), /kit it needs/);
  // screen_mock and cartoon_rigged are built (E5 sources, opened in E5 follow-up): they have no gap, so rule 6 keeps them.
  assert.equal(gapOf("screen_mock"), "", "screen_mock is not rejected by rule 6 when its kits are present");
  assert.equal(gapOf("cartoon_rigged"), "", "cartoon_rigged is not rejected by rule 6 when its rig is present");
});

test("rule 6 refuses a component the shot's own words cannot be drawn as, with the reason from its source", () => {
  const refusals = { screen_mock: "a one-line screen needs the product's name for its app" };
  const refused = filterCandidates(base({ refusals })).rejected.find((item) => item.visualType === "screen_mock");
  assert.equal(refused?.rule, "rule6_kit");
  assert.match(refused?.detail ?? "", /cannot be built as this type: a one-line screen needs the product's name/);
});

test("rule 5: an unknown (null) price removes the candidate; it is never priced at 0", () => {
  const input = base({ remainingUsd: 100 });
  const reasons = filterCandidates(input).rejected.filter((item) => item.visualType === "stop_motion");
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].rule, "rule5_budget");
  assert.match(reasons[0].detail, /unknown price/);
  assert.ok(!keptTypes(input).includes("stop_motion"));
});

test("rule 6: a type whose kit is missing is removed", () => {
  const noPersona = base({ kits: { ...ALL_KITS, persona: false } });
  assert.ok(rejectedBy(noPersona, "rule6_kit").includes("ugc_presenter"));
  assert.ok(rejectedBy(noPersona, "rule6_kit").includes("react_clip"));
  const noRig = base({ kits: { ...ALL_KITS, rigCharacter: false } });
  const riggedDetail = filterCandidates(noRig).rejected.find((item) => item.visualType === "cartoon_rigged")?.detail ?? "";
  assert.match(riggedDetail, /the kit it needs is missing: rigCharacter/, "without a usable rig, cartoon_rigged is removed for its kit");
  assert.ok(keptTypes(base({})).includes("cartoon_rigged"), "with the rig, cartoon_rigged is kept");
  // cartoon_generated is a build gap, so it is removed whatever the kits are; the rig kit is not its reason.
  const generatedDetail = filterCandidates(noRig).rejected.find((item) => item.visualType === "cartoon_generated")?.detail ?? "";
  assert.doesNotMatch(generatedDetail, /rig/);
  const noProduct = base({ kits: { ...ALL_KITS, productKit: false } });
  assert.ok(rejectedBy(noProduct, "rule6_kit").includes("product_hero"));
  // stop_motion has no known price, so rule 5 removes it before rule 6 is reached.
  assert.ok(!keptTypes(noProduct).includes("stop_motion"));
});

test("the first rule that removes a candidate is the one recorded", () => {
  const input = base({ textInPixels: true, handsOnProduct: true, remainingUsd: 0, kits: { ...ALL_KITS, persona: false } });
  const ugc = filterCandidates(input).rejected.find((item) => item.visualType === "ugc_presenter");
  assert.equal(ugc?.rule, "rule3_text_in_pixels");
});

test("kept candidates keep their pool order", () => {
  const order: VisualType[] = ["stock_footage", "coded_graphics", "kinetic_type"];
  assert.deepEqual(keptTypes(base({ candidates: pool(order) })), order);
});
