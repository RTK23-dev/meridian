import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type EditDecisionList, type ProductionRequest, type VariantMatrix } from "../contracts/index.ts";
import { edlFixture, FIXTURE_IDS, productionRequestFixture, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { expandVariants, type ExpansionInput, type PlannedVariant } from "./expand.ts";
import { callScopeOf, generationWorkOf, nextPhaseOf, variantRequestFor, variantSubjectOf, variantWorkItemSchema, type VariantWorkItem } from "./work.ts";

const REQUEST = productionRequestFixture as ProductionRequest;
const ALL_BEATS = REQUEST.script.beats.map((beat) => beat.beatId);
const HOOK_SHOT = FIXTURE_IDS.shot1;
const PRODUCT_SHOT = FIXTURE_IDS.shot3;

/** The planned variants of a matrix, from the expansion (the one the stage uses), against the chain fixture's master. */
function planned(matrix: Partial<VariantMatrix>): PlannedVariant[] {
  const input: ExpansionInput = {
    request: REQUEST,
    plan: scenePlanFixture,
    master: edlFixture as EditDecisionList,
    matrix: { maxVariants: 20, budgetUsd: 5, ...matrix },
    tracks: new Map(),
    headroomUsd: 5,
  };
  return expandVariants(input).planned;
}

function itemOf(matrix: Partial<VariantMatrix>): VariantWorkItem {
  const variant = planned(matrix)[0];
  if (variant === undefined) throw new Error("the matrix plans no variant");
  const item = generationWorkOf(variant, REQUEST);
  if (item === null) throw new Error("the variant needs no generation");
  return item;
}

describe("the work list of a generation variant (Bible 6.13)", () => {
  it("a hook writes its hook line, speaks every beat of its script, and produces its hook shot only", () => {
    const item = itemOf({ hooks: 1 });
    assert.equal(item.attribute, "hook");
    assert.deepEqual(item.writer, { kind: "lines", beatIds: ["b1"] });
    assert.deepEqual(item.voiceBeatIds, ALL_BEATS, "a full re-speak (variants/STATUS.md)");
    assert.deepEqual(item.produceShotIds, [HOOK_SHOT]);
    assert.deepEqual(item.change, { kind: "hook", index: 1 });
  });

  it("a product writes a prompt for each product shot, speaks nothing, and produces the product shots only", () => {
    const item = itemOf({ products: ["SKU-FIX-002"] });
    assert.equal(item.attribute, "product");
    assert.deepEqual(item.writer, { kind: "product_prompts", shotIds: [PRODUCT_SHOT] });
    assert.deepEqual(item.voiceBeatIds, []);
    assert.deepEqual(item.produceShotIds, [PRODUCT_SHOT]);
    assert.deepEqual(item.change, { kind: "product", sku: "SKU-FIX-002" });
  });

  it("a persona writes no words and speaks every beat in its voice", () => {
    const item = itemOf({ personas: ["persona_variant"] });
    assert.equal(item.writer, null);
    assert.deepEqual(item.voiceBeatIds, ALL_BEATS);
    assert.deepEqual(item.change, { kind: "persona", personaId: "persona_variant" });
  });

  it("a language writes every beat and speaks every beat in the language", () => {
    const item = itemOf({ languages: ["de"] });
    assert.deepEqual(item.writer, { kind: "lines", beatIds: ALL_BEATS });
    assert.deepEqual(item.voiceBeatIds, ALL_BEATS);
    assert.deepEqual(item.change, { kind: "language", language: "de" });
  });

  it("a caption or a music variant has no work list item: it needs no generation", () => {
    const caption = planned({ captionStyles: ["lower"] })[0];
    assert.ok(caption);
    if (caption) assert.equal(generationWorkOf(caption, REQUEST), null);
  });

  it("every item parses against its schema, and its subject carries no ':' or '.'", () => {
    for (const matrix of [{ hooks: 1 }, { products: ["SKU-FIX-002"] }, { personas: ["persona_variant"] }, { languages: ["de"] }]) {
      const item = itemOf(matrix);
      assert.equal(variantWorkItemSchema.safeParse(item).success, true, JSON.stringify(item));
      assert.doesNotMatch(item.subject, /[:.]/);
    }
  });
});

describe("the phases of a generation variant, in order (jobs/variant-runs.ts)", () => {
  it("a hook runs its writer, its voice and its plan, in that order", () => {
    const item = itemOf({ hooks: 1 });
    assert.equal(nextPhaseOf(item, []), "writer");
    assert.equal(nextPhaseOf(item, ["writer"]), "voice");
    assert.equal(nextPhaseOf(item, ["writer", "voice"]), "plan");
    assert.equal(nextPhaseOf(item, ["writer", "voice", "plan"]), null);
  });

  it("a product runs its writer and its plan, with no voice", () => {
    const item = itemOf({ products: ["SKU-FIX-002"] });
    assert.equal(nextPhaseOf(item, []), "writer");
    assert.equal(nextPhaseOf(item, ["writer"]), "plan");
  });

  it("a persona runs its voice and its plan, with no writer", () => {
    const item = itemOf({ personas: ["persona_variant"] });
    assert.equal(nextPhaseOf(item, []), "voice");
    assert.equal(nextPhaseOf(item, ["voice"]), "plan");
  });
});

describe("a variant's own script, and its job subject (variants/work.ts)", () => {
  it("speaks every beat of the master, with the writer's line in place of its beat, and the variant's language", () => {
    const built = variantRequestFor({ request: REQUEST, language: "en", lines: [{ beatId: "b1", text: "A new opening." }] });
    assert.deepEqual(built.script.beats.map((beat) => beat.beatId), ALL_BEATS);
    assert.equal(built.script.beats[0]?.text, "A new opening.");
    assert.equal(built.script.beats[1]?.text, REQUEST.script.beats[1]?.text);
  });

  it("refuses a line for a beat that is not in the request, and two lines for one beat", () => {
    assert.throws(
      () => variantRequestFor({ request: REQUEST, language: "en", lines: [{ beatId: "b9", text: "x" }] }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.throws(
      () => variantRequestFor({ request: REQUEST, language: "en", lines: [{ beatId: "b1", text: "x" }, { beatId: "b1", text: "y" }] }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("gives two keys that slug to the same text two different subjects, stable across calls", () => {
    assert.notEqual(variantSubjectOf("product:a-b"), variantSubjectOf("product:a.b"));
    assert.equal(variantSubjectOf("hook:2"), variantSubjectOf("hook:2"));
    assert.match(variantSubjectOf("hook:2"), /^[A-Za-z0-9-]+$/);
  });

  it("scopes the provider calls of two variants to two different numbers, inside the seed range", () => {
    const hook = callScopeOf(variantSubjectOf("hook:1"));
    const persona = callScopeOf(variantSubjectOf("persona:x"));
    assert.notEqual(hook, persona);
    assert.ok(Number.isInteger(hook) && hook >= 0 && hook < 2 ** 24);
  });
});
