import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "../../lib/meridian/a11y/contrast.ts";

// The video canvas's own palette (styles.css, .kc). Every text colour must read on the surface it is drawn on, in both themes: 4.5:1 for
// text, 3:1 for the focus ring. The light theme inherits what it does not set from the dark palette.
const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

function body(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `styles.css has no ${selector} rule`);
  const open = css.indexOf("{", start);
  const text = css.slice(open + 1, css.indexOf("\n}", open));
  return Object.fromEntries([...text.matchAll(/--(kc-[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

const dark = body(".kc");
const light = { ...dark, ...body(':root[data-theme="light"] .kc') };

/** A hex colour with an rgb(r g b / a) laid over it. */
function over(base: string, rgba: string): string {
  const match = rgba.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  assert.ok(match, `not an rgb() with alpha: ${rgba}`);
  const [r, g, b, a] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  const channel = (i: number, top: number) => Math.round(parseInt(base.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a) + top * a);
  return `#${[channel(0, r), channel(1, g), channel(2, b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

const TEXT_PAIRS: Array<[string, string]> = [
  ["kc-tile-ink", "kc-tile"],
  ["kc-tile-muted", "kc-tile"],
  ["kc-card-ink", "kc-card-top"],
  ["kc-card-ink", "kc-card-mid"],
  ["kc-card-ink", "kc-card-end"],
  ["kc-card-muted", "kc-card-top"],
  ["kc-card-muted", "kc-card-mid"],
  ["kc-card-muted", "kc-card-end"],
  ["kc-card-ink", "kc-note-body"],
  ["kc-card-muted", "kc-note-body"],
  ["kc-later-ink", "kc-later"],
  ["kc-on-vermilion", "kc-vermilion"],
  ["kc-on-badge", "kc-badge"],
  ["kc-pill-ink", "kc-pill"],
  ["kc-plus-ink", "kc-plus"],
  ["kc-room-ink", "kc-room"],
  ["kc-room-muted", "kc-room"],
  ["kc-room-muted", "kc-side"],
  ["kc-tile-ink", "kc-rail"],
];

test("every text colour of the canvas reads on its surface in both themes", () => {
  for (const [theme, palette] of [["dark", dark], ["light", light]] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrastRatio(palette[fg]!, palette[bg]!);
      assert.ok(ratio >= 4.5, `${theme}: --${fg} on --${bg} is ${ratio}:1`);
    }
    assert.ok(contrastRatio(palette["kc-focus"]!, palette["kc-room"]!) >= 3, `${theme}: the focus ring must show on the room`);
  }
});

test("text on the board still reads where the warm wash is strongest", () => {
  for (const [theme, palette] of [["dark", dark], ["light", light]] as const) {
    const washed = over(palette["kc-room"]!, palette["kc-wash"]!);
    assert.ok(contrastRatio(palette["kc-room-ink"]!, washed) >= 4.5, `${theme}: --kc-room-ink on the washed room ${washed}`);
  }
});
