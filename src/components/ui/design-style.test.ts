import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_DESIGN_STYLE, DESIGN_STORAGE_KEY, DESIGN_STYLE_INFO, DESIGN_STYLES, designStyleBootstrap, parseDesignStyle, type DesignStyle } from "./design-style.ts";

const tokenFile = (style: DesignStyle) =>
  JSON.parse(readFileSync(new URL(`../../../docs/design/tokens/${style}-tokens.json`, import.meta.url), "utf8")) as {
    themes: Record<"dark" | "light", Record<string, string>>;
  };

/** Runs the before-paint script with a stored value (or a storage that cannot be read) and returns the data-design it set. */
function bootstrapped(stored: string | null | "unreadable"): string | undefined {
  const attributes: Record<string, string> = {};
  const storage = {
    getItem(key: string) {
      assert.equal(key, DESIGN_STORAGE_KEY);
      if (stored === "unreadable") throw new Error("storage is disabled");
      return stored;
    },
  };
  const documentStub = { documentElement: { setAttribute: (name: string, value: string) => { attributes[name] = value; } } };
  new Function("localStorage", "document", designStyleBootstrap)(storage, documentStub);
  return attributes["data-design"];
}

test("the app offers the two designs, and Katana is the default", () => {
  assert.deepEqual([...DESIGN_STYLES], ["katana", "attentionos"]);
  assert.equal(DEFAULT_DESIGN_STYLE, "katana");
});

test("a stored or submitted value that names no design falls back to the default", () => {
  assert.equal(parseDesignStyle("katana"), "katana");
  assert.equal(parseDesignStyle("attentionos"), "attentionos");
  for (const value of [null, undefined, "", "KATANA", "red", 0, {}]) {
    assert.equal(parseDesignStyle(value), DEFAULT_DESIGN_STYLE, `${String(value)} must fall back to the default`);
  }
});

test("the before-paint script applies the stored design, and keeps the default when storage cannot be read", () => {
  assert.equal(bootstrapped("katana"), "katana");
  assert.equal(bootstrapped("attentionos"), "attentionos");
  assert.equal(bootstrapped(null), "katana");
  assert.equal(bootstrapped("unreadable"), "katana");
  assert.equal(bootstrapped("red"), "katana");
});

test("the preview in Settings shows the accent, surface and text that each design's token file defines for dark", () => {
  for (const style of DESIGN_STYLES) {
    const dark = tokenFile(style).themes.dark;
    const preview = DESIGN_STYLE_INFO[style].preview;
    assert.equal(preview.accent.toUpperCase(), dark.accent.toUpperCase(), `${style} preview accent`);
    assert.equal(preview.surface.toUpperCase(), dark["bg-raised"].toUpperCase(), `${style} preview surface`);
    assert.equal(preview.text.toUpperCase(), dark["fg-primary"].toUpperCase(), `${style} preview text`);
  }
});
