import assert from "node:assert/strict";
import test from "node:test";
import { contrastRatio } from "../../lib/meridian/a11y/contrast.ts";
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentTokens, presetFor } from "./accent.ts";

// The room the accent sits on: the dark room is black, and the light room is white.
const ROOM = { dark: "#000000", light: "#FFFFFF" } as const;
const HEX = /^#[0-9A-F]{6}$/;

test("every preset has five valid colours in each theme, and the ids are unique", () => {
  const ids = ACCENT_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of ACCENT_PRESETS) {
    for (const theme of ["dark", "light"] as const) {
      for (const value of Object.values(preset[theme])) assert.match(value, HEX, `${preset.id} ${theme}`);
    }
  }
});

test("every preset passes the contrast rules in both themes", () => {
  for (const preset of ACCENT_PRESETS) {
    for (const theme of ["dark", "light"] as const) {
      const colours = preset[theme];
      assert.ok(contrastRatio(colours.text, ROOM[theme]) >= 4.5, `${preset.id} ${theme}: text on the room`);
      assert.ok(contrastRatio(colours.on, colours.accent) >= 4.5, `${preset.id} ${theme}: label on the accent`);
      assert.ok(contrastRatio(colours.on, colours.hover) >= 4.5, `${preset.id} ${theme}: label on the hover`);
    }
  }
});

test("the default accent is the red of the design, and it is the Katana red", () => {
  const red = presetFor(DEFAULT_ACCENT);
  assert.equal(red.id, "red");
  assert.equal(red.dark.accent, "#FF2E38");
  assert.equal(red.dark.hover, "#FF5A63");
  assert.equal(red.light.accent, "#C8102E");
  assert.equal(red.light.hover, "#A50D25");
});

test("a preset id that is not known falls back to the default", () => {
  assert.equal(presetFor("not-a-colour").id, DEFAULT_ACCENT);
  assert.equal(presetFor(null).id, DEFAULT_ACCENT);
  assert.equal(presetFor("blue").id, "blue");
});

test("a preset sets the five accent properties for one theme", () => {
  const blue = presetFor("blue");
  assert.deepEqual(accentTokens(blue, "dark"), {
    "--accent": blue.dark.accent,
    "--accent-hover": blue.dark.hover,
    "--accent-text": blue.dark.text,
    "--accent-muted": blue.dark.muted,
    "--on-accent": blue.dark.on,
  });
});
