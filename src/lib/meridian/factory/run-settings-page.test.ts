import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUN_SETTINGS, mergeRunSettings, parseRunSettings, parseStoredSettings } from "./run-settings.ts";
import { draftFromDefaults, settingsFromDraft } from "./run-builder-model.ts";

test("a run has no page by default, and a page id is stored with the run", () => {
  assert.equal(DEFAULT_RUN_SETTINGS.pageId, null);
  const parsed = parseRunSettings({ pageId: "page_1-abc" });
  assert.deepEqual(parsed.ok && parsed.value.pageId, "page_1-abc");
});

test("a run's own page overrides the brand default, and an unset page keeps the default", () => {
  const brandDefault = mergeRunSettings(null, { pageId: "brand-page" });
  assert.equal(brandDefault.pageId, "brand-page");
  assert.equal(mergeRunSettings({ pageId: "brand-page" }, { pageId: "run-page" }).pageId, "run-page");
  assert.equal(mergeRunSettings({ pageId: "brand-page" }, null).pageId, "brand-page");
});

test("a page id that is not a plain id is refused, and null clears the page", () => {
  for (const bad of ["page with spaces", "../etc", "", "x".repeat(65), 42]) {
    const parsed = parseRunSettings({ pageId: bad });
    assert.equal(parsed.ok, false, `refused: ${JSON.stringify(bad)}`);
  }
  const cleared = parseRunSettings({ pageId: null }, { ...DEFAULT_RUN_SETTINGS, pageId: "page-1" });
  assert.equal(cleared.ok && cleared.value.pageId, null);
});

test("a stored run without a page reads as no page, and a stored page id survives a read", () => {
  const older = parseStoredSettings(JSON.stringify({ intent: "organic" }));
  assert.equal(older?.pageId, null);
  const stored = parseStoredSettings(JSON.stringify({ ...DEFAULT_RUN_SETTINGS, pageId: "page-9" }));
  assert.equal(stored?.pageId, "page-9");
});

test("the run builder carries the chosen page into the settings it starts with, and none when blank", () => {
  const draft = draftFromDefaults({ ...DEFAULT_RUN_SETTINGS, pageId: "page-7" });
  assert.equal(draft.pageId, "page-7");
  assert.equal(settingsFromDraft({ ...draft, pageId: "" }).pageId, null);
  assert.equal(settingsFromDraft({ ...draft, pageId: "  " }).pageId, null);
  assert.equal(settingsFromDraft(draft).pageId, "page-7");
  assert.equal(draftFromDefaults(DEFAULT_RUN_SETTINGS).pageId, "", "no page is typed into the select by default");
});
