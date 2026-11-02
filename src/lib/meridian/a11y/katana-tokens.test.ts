// Checks the proposed Katana tokens (docs/design/tokens/katana-tokens.json) three ways: every contrast pair meets its minimum in its
// theme, the JSON agrees with the CSS block in the Katana plan (section l), and every ratio the Katana plan states in its colour table
// (section b) is the ratio the repo's own helper computes. The third check tests the plan's figures instead of trusting them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrastRatio } from "./contrast.ts";

type Theme = "dark" | "light";
type Pair = { fg: string; bg: string; min: number; use?: string };
type Tokens = { themes: Record<Theme, Record<string, string>>; contrast: Pair[] };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = JSON.parse(read("../../../../docs/design/tokens/katana-tokens.json")) as Tokens;
const plan = read("../../../../docs/design/KATANA_DESIGN_PLAN.md");

const hex = (theme: Theme, key: string): string => {
  const value = tokens.themes[theme][key];
  assert.ok(value, `${theme} is missing the token ${key}`);
  return value;
};

test("every contrast pair meets its minimum in both themes", () => {
  const failures: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    for (const pair of tokens.contrast) {
      const ratio = contrastRatio(hex(theme, pair.fg), hex(theme, pair.bg));
      if (ratio < pair.min) failures.push(`${theme}: ${pair.fg} on ${pair.bg} is ${ratio}:1, needs ${pair.min}:1 (${pair.use ?? "text"})`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the contrast table keeps the thirty pairs of the Katana plan and adds the mixed plan's pairs", () => {
  assert.ok(tokens.contrast.length >= 35, `expected at least 35 pairs, found ${tokens.contrast.length}`);
});

test("no tinted status tokens: status is a dot and a word, never a -soft fill", () => {
  for (const theme of ["dark", "light"] as const) {
    const soft = Object.keys(tokens.themes[theme]).filter((key) => key.endsWith("-soft"));
    assert.deepEqual(soft, []);
  }
});

test("the JSON agrees with the Katana plan's CSS token block for every colour it defines", () => {
  const block = plan.match(/```css\n([\s\S]*?)```/g)?.find((candidate) => candidate.includes("Katana tokens"));
  assert.ok(block, "section l of the Katana plan has a CSS token block");
  const dark = block.match(/:root, :root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const light = block.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const declared = (body: string) => new Map([...body.matchAll(/--([a-z-]+): (#[0-9A-Fa-f]{6});/g)].map((m) => [m[1], m[2].toUpperCase()]));
  const themes: Array<[Theme, Map<string, string>]> = [["dark", declared(dark)], ["light", declared(light)]];
  for (const [theme, css] of themes) {
    assert.ok(css.size >= 16, `the plan's ${theme} block declares ${css.size} colours`);
    for (const [key, value] of css) {
      assert.equal(hex(theme, key).toUpperCase(), value, `${theme} --${key} differs between the JSON and the plan`);
    }
  }
});

test("every ratio the Katana plan states in its colour table is the computed ratio", () => {
  // Rows look like: | pair | min | #FF2E38 on #000000 = **5.70:1** | #C8102E on #FFFFFF = **5.88:1** | pass |
  const stated = [...plan.matchAll(/#([0-9A-Fa-f]{6}) on #([0-9A-Fa-f]{6}) = \*\*([\d.]+):1\*\*/g)];
  assert.ok(stated.length >= 60, `expected 30 rows of two stated ratios, found ${stated.length}`);
  const mismatches: string[] = [];
  for (const m of stated) {
    const computed = contrastRatio(`#${m[1]}`, `#${m[2]}`);
    const claimed = Number(m[3]);
    if (Math.abs(computed - claimed) > 0.005) mismatches.push(`#${m[1]} on #${m[2]}: plan says ${claimed}, helper computes ${computed}`);
  }
  assert.deepEqual(mismatches, []);
});
