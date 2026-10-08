import assert from "node:assert/strict";
import test from "node:test";
import {
  ANGLE_BIBLE_DIMENSIONS,
  getBibleEntryBySlug,
  getBibleEntriesForNiche,
} from "./bible.ts";

test("Angle Bible contains all 11 core dimensions with valid entries", () => {
  assert.equal(ANGLE_BIBLE_DIMENSIONS.length, 11);

  const dimensionNames = ANGLE_BIBLE_DIMENSIONS.map((d) => d.name);
  assert.ok(dimensionNames.includes("Hook Mechanism"));
  assert.ok(dimensionNames.includes("Format Structure"));
  assert.ok(dimensionNames.includes("Emotional Driver"));
  assert.ok(dimensionNames.includes("Retention Architecture"));
  assert.ok(dimensionNames.includes("Visual Craft"));
  assert.ok(dimensionNames.includes("Audio Direction"));
  assert.ok(dimensionNames.includes("Persona and Point of View"));
  assert.ok(dimensionNames.includes("Share Trigger"));
  assert.ok(dimensionNames.includes("Conversion Pattern"));
  assert.ok(dimensionNames.includes("Trend Context"));
  assert.ok(dimensionNames.includes("Product Integration Angle"));

  for (const dim of ANGLE_BIBLE_DIMENSIONS) {
    assert.ok(dim.entries.length > 0, `Dimension ${dim.name} has no entries`);
    for (const entry of dim.entries) {
      assert.ok(entry.slug.length > 0);
      assert.ok(entry.definition.length > 0);
      assert.ok(entry.psychologicalMechanism.length > 0);
      assert.ok(entry.onScreenCues.length > 0);
      assert.ok(entry.failureModes.length > 0);
    }
  }
});

test("getBibleEntryBySlug retrieves entry or returns null", () => {
  const resultFirst = getBibleEntryBySlug("result-first");
  assert.ok(resultFirst);
  assert.equal(resultFirst.name, "Result First / Payoff Tease");
  assert.equal(resultFirst.dimensionName, "Hook Mechanism");

  const nonExistent = getBibleEntryBySlug("non-existent-entry");
  assert.equal(nonExistent, null);
});

test("getBibleEntriesForNiche filters appropriately by niche", () => {
  const beautyEntries = getBibleEntriesForNiche("beauty");
  assert.ok(beautyEntries.length > 0);
  assert.ok(beautyEntries.some((e) => e.slug === "result-first"));

  const saasEntries = getBibleEntriesForNiche("saas");
  assert.ok(saasEntries.length > 0);
  assert.ok(saasEntries.some((e) => e.slug === "keyword-to-dm"));
});
