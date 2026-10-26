// Which catalogue entries may be chosen to write text, and which may read an image. A decision model is never a generation model, even
// when a text listing returned it, and a model whose output is not stated as text cannot be chosen. Fixture entries only: no request.

import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogEntry } from "./catalog.ts";
import { isTextGenerationEntry, textChoices, visionChoices } from "./settings.ts";

function entry(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, "id">): CatalogEntry {
  return {
    name: overrides.id,
    kind: "text",
    input_modalities: ["text"],
    output_modalities: ["text"],
    pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, imageUsd: null, usdPerSecond1080p: null },
    ...overrides,
  } as CatalogEntry;
}

test("a decision model returned by a text listing is not a text-generation model", () => {
  const decision = entry({ id: "fixture/decider", output_modalities: ["decisions"], input_modalities: ["text", "image"] });
  assert.equal(isTextGenerationEntry(decision), false);
  const catalog = new Map([[decision.id, decision]]);
  assert.deepEqual(textChoices(catalog), [], "the decision model is not offered for writing");
});

test("a text model must state text as its output, and both token prices must be known", () => {
  const unstated = entry({ id: "fixture/no-output-stated", output_modalities: null });
  const unpriced = entry({ id: "fixture/unpriced", pricing: { promptUsdPerToken: null, completionUsdPerToken: 0.000002, imageUsd: null, usdPerSecond1080p: null } });
  const writer = entry({ id: "fixture/writer" });
  assert.equal(isTextGenerationEntry(unstated), false, "an output not stated as text is not chosen");
  assert.equal(isTextGenerationEntry(unpriced), false, "an unpriced model is not chosen");
  assert.deepEqual(
    textChoices(new Map([unstated, unpriced, writer].map((item) => [item.id, item]))).map((choice) => choice.id),
    ["fixture/writer"],
  );
});

test("a vision model is a text model that also takes image input", () => {
  const writer = entry({ id: "fixture/writer", input_modalities: ["text"] });
  const looker = entry({ id: "fixture/looker", input_modalities: ["text", "image"] });
  const catalog = new Map([writer, looker].map((item) => [item.id, item]));
  assert.deepEqual(visionChoices(catalog).map((choice) => choice.id), ["fixture/looker"]);
  assert.deepEqual(textChoices(catalog).map((choice) => choice.id), ["fixture/looker", "fixture/writer"].sort(), "both can write text");
});

test("a non-text catalogue entry is never a text-generation model, whatever its output", () => {
  const image = entry({ id: "fixture/picture", kind: "image", output_modalities: ["text"] });
  assert.equal(isTextGenerationEntry(image), false);
});
