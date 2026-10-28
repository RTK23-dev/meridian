import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTENT_SECTIONS,
  CONTENT_SECTION_LABELS,
  CREATE_PRESETS,
  LEGACY_CONTENT_ROUTES,
  contentSearchOf,
  defaultPreset,
  isContentSection,
  presetsFor,
  searchForSection,
  sectionOf,
  sectionsFor,
} from "./content-hub-model.ts";

test("a section name is read only when it is one of the page's sections", () => {
  assert.equal(sectionOf("review"), "review");
  assert.equal(sectionOf("ads"), "ads");
  assert.equal(sectionOf("settings"), "create");
  assert.equal(sectionOf(undefined), "create");
  assert.equal(sectionOf(42), "create");
  assert.equal(sectionOf("nope", "ideas"), "ideas");
  assert.equal(isContentSection("results"), true);
  assert.equal(isContentSection("Results"), false);
});

test("members do not see the admin sections, and admins see every section in order", () => {
  assert.deepEqual(sectionsFor(false), ["create", "ideas", "review", "library", "publish", "results"]);
  assert.deepEqual(sectionsFor(true), [...CONTENT_SECTIONS]);
});

test("members start in Studio, admins start in the engine on its simplest start", () => {
  assert.equal(defaultPreset(false).mode, "studio");
  assert.equal(defaultPreset(true).mode, "engine");
  assert.equal(defaultPreset(true).id, "brief", "the simplest engine start opens first");
  assert.deepEqual(presetsFor(false).map((preset) => preset.id), ["studio"]);
  assert.deepEqual(presetsFor(true).map((preset) => preset.id), ["brief", "reference", "studio"]);
});

test("every section and every preset has a name a person can read", () => {
  for (const section of CONTENT_SECTIONS) assert.ok(CONTENT_SECTION_LABELS[section].length > 0, section);
  const ids = new Set<string>();
  for (const preset of CREATE_PRESETS) {
    assert.ok(preset.label.length > 0, preset.id);
    assert.ok(preset.description.length > 20, preset.id);
    assert.equal(ids.has(preset.id), false, `duplicate preset ${preset.id}`);
    ids.add(preset.id);
  }
});

test("every screen that moved into the content page opens its section, and Studio opens Create in Studio", () => {
  for (const [route, search] of Object.entries(LEGACY_CONTENT_ROUTES)) {
    assert.equal(isContentSection(search.section), true, `${route} opens a section`);
    if (search.preset !== undefined) assert.ok(CREATE_PRESETS.some((preset) => preset.id === search.preset), `${route} opens a preset`);
  }
  assert.deepEqual(LEGACY_CONTENT_ROUTES.studio, { section: "create", preset: "studio" });
  assert.equal(LEGACY_CONTENT_ROUTES.accounts.section, "publish", "connected accounts are the Publish section");
  assert.equal(LEGACY_CONTENT_ROUTES.factory.section, "ads", "the factory opens the admin-only Batch section");
});

test("moving between sections keeps the chosen starting mode and drops the engine session", () => {
  assert.deepEqual(searchForSection({ section: "create", preset: "studio", session: "s_1" }, "review"), { section: "review", preset: "studio" });
  assert.deepEqual(searchForSection({ session: "s_1" }, "ideas"), { section: "ideas" });
});

test("the search values the page accepts are kept, and anything else is dropped", () => {
  assert.deepEqual(contentSearchOf({ section: "library", preset: "studio", session: "s_1" }), {
    section: "library",
    preset: "studio",
    session: "s_1",
  });
  assert.deepEqual(contentSearchOf({ section: "settings", preset: "", session: 7 }), {});
  assert.deepEqual(contentSearchOf({ preset: "x".repeat(41) }), {});
  assert.deepEqual(contentSearchOf({ session: "s".repeat(81) }), {});
});
