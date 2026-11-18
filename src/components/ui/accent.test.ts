import assert from "node:assert/strict";
import test from "node:test";
import { contrastRatio } from "../../lib/meridian/a11y/contrast.ts";
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentTokens, presetFor } from "./accent.ts";

// The rooms the accent sits on (the canvas system, owner direction 2026-11-18): near-black, and a warm mid-grey.
const ROOM = { dark: "#0D0D0E", light: "#D3D3D4" } as const;
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

test("the default accent is the red of the design, the canvas system's vermilion", () => {
  const red = presetFor(DEFAULT_ACCENT);
  assert.equal(red.id, "red");
  assert.equal(red.dark.accent, "#E0573A");
  assert.equal(red.dark.hover, "#E9705A");
  assert.equal(red.light.accent, "#D2462A");
  assert.equal(red.light.hover, "#DE5E43");
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
