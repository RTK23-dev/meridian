import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contrastRatio } from "../../lib/meridian/a11y/contrast.ts";

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

function tokens(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) values[match[1]] = match[2];
  return values;
}

function block(pattern: RegExp, label: string): string {
  const match = css.match(pattern);
  assert.ok(match, `styles.css has no ${label} block`);
  return match[1];
}

const light = tokens(block(/@theme \{([\s\S]*?)\n\}/, "@theme"));
const dark = tokens(block(/\n\.dark \{([\s\S]*?)\n\}/, ".dark"));

// Text pairs need 4.5:1 (WCAG AA). Pairs in `ui` are boundaries and icons that need 3:1.
const text: Array<[string, string]> = [
  ["fg", "bg"], ["fg", "surface"], ["fg", "surface-2"],
  ["fg-muted", "bg"], ["fg-muted", "surface"], ["fg-muted", "surface-2"],
  ["fg", "accent-soft"], ["fg-muted", "accent-soft"],
  ["accent", "bg"], ["accent", "surface"], ["accent-fg", "accent"],
  ["success", "surface"], ["success", "success-soft"],
  ["warning", "surface"], ["warning", "warning-soft"],
  ["danger", "surface"], ["danger", "danger-soft"],
  ["info", "surface"], ["info", "info-soft"],
  ["bg", "fg"],
];
const ui: Array<[string, string]> = [
  ["border-strong", "surface"], ["border-strong", "bg"], ["accent", "surface-2"],
];

function check(theme: Record<string, string>, name: string) {
  for (const [foreground, background] of text) {
    const fg = theme[`--color-${foreground}`];
    const bg = theme[`--color-${background}`];
    assert.ok(fg && bg, `${name} is missing --color-${foreground} or --color-${background}`);
    assert.ok(contrastRatio(fg, bg) >= 4.5, `${name}: ${foreground} ${fg} on ${background} ${bg} is ${contrastRatio(fg, bg)}:1, below 4.5:1`);
  }
  for (const [foreground, background] of ui) {
    const fg = theme[`--color-${foreground}`];
    const bg = theme[`--color-${background}`];
    assert.ok(contrastRatio(fg, bg) >= 3, `${name}: ${foreground} ${fg} on ${background} ${bg} is ${contrastRatio(fg, bg)}:1, below 3:1`);
  }
}

test("light and dark palettes meet WCAG contrast for text and UI boundaries", () => {
  check(light, "light");
  check({ ...light, ...dark }, "dark");
});

test("dark theme overrides every semantic color, so no token silently keeps its light value", () => {
  const semantic = Object.keys(light).filter((name) => !/^--color-(ink|paper|panel|line|muted|brass)$/.test(name));
  const missing = semantic.filter((name) => !(name in dark));
  assert.deepEqual(missing, [], `dark theme does not override: ${missing.join(", ")}`);
});

test("legacy aliases resolve inline so each theme gets its own value", () => {
  assert.match(css, /@theme inline \{[\s\S]*?--color-brass: var\(--color-accent\);[\s\S]*?\}/);
  assert.match(css, /@theme inline \{[\s\S]*?--color-muted: var\(--color-fg-muted\);/);
});

test("serif display font is limited to page titles and explicit opt-ins, not every heading", () => {
  const baseRule = css.match(/h1, \.font-display \{/);
  assert.ok(baseRule, "the base serif rule should target h1 and .font-display only");
  assert.doesNotMatch(css, /h1, h2, h3/);
});
