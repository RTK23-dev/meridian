import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, accentTokens, contrast, effectiveTheme, presetFor, readAccentChoice, writeAccentChoice,
} from "../docs/design/prototype/accent.mjs";

// The rooms the accent sits on: the dark room is black, and the light room is white.
const ROOM = { dark: "#000000", light: "#FFFFFF" };
const HEX = /^#[0-9A-F]{6}$/;

test("every preset has five valid colours in each theme, and the ids are unique", () => {
  const ids = ACCENT_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of ACCENT_PRESETS) {
    for (const theme of ["dark", "light"]) {
      for (const value of Object.values(preset[theme])) assert.match(value, HEX, `${preset.id} ${theme}`);
    }
  }
});

test("every preset passes the contrast rules in both themes", () => {
  for (const preset of ACCENT_PRESETS) {
    for (const theme of ["dark", "light"]) {
      const colours = preset[theme];
      // Accent text on the room, for links and selected tabs: 4.5 to 1 or more.
      assert.ok(contrast(colours.text, ROOM[theme]) >= 4.5, `${preset.id} ${theme}: text on the room`);
      // The label on the accent fill, and on the hover fill: 4.5 to 1 or more.
      assert.ok(contrast(colours.on, colours.accent) >= 4.5, `${preset.id} ${theme}: label on the accent`);
      assert.ok(contrast(colours.on, colours.hover) >= 4.5, `${preset.id} ${theme}: label on the hover`);
    }
  }
});

test("the default accent is the red the design was drawn in, so the default look does not change", () => {
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

test("an explicit theme choice wins over the system setting", () => {
  assert.equal(effectiveTheme("dark", true), "dark");
  assert.equal(effectiveTheme("light", false), "light");
  assert.equal(effectiveTheme(undefined, true), "light");
  assert.equal(effectiveTheme(undefined, false), "dark");
  assert.equal(effectiveTheme("sepia", false), "dark");
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

test("the contrast of black on white is 21 to 1, and of a colour with itself is 1 to 1", () => {
  assert.ok(Math.abs(contrast("#000000", "#FFFFFF") - 21) < 1e-9);
  assert.ok(Math.abs(contrast("#4D9DFF", "#4D9DFF") - 1) < 1e-9);
});

test("a storage that refuses access reads as no choice and does not throw on save", () => {
  const refusing = {
    getItem() { throw new Error("refused"); },
    setItem() { throw new Error("refused"); },
  };
  assert.equal(readAccentChoice(refusing), null);
  assert.doesNotThrow(() => writeAccentChoice(refusing, "blue"));
  assert.equal(readAccentChoice(null), null);
});

test("a saved choice is read back from storage", () => {
  const store = new Map();
  const memory = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  writeAccentChoice(memory, "teal");
  assert.equal(readAccentChoice(memory), "teal");
});
