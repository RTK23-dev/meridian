import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./lib/meridian/a11y/contrast.ts";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const tokenFile = JSON.parse(readFileSync(new URL("../docs/design/tokens/katana-tokens.json", import.meta.url), "utf8")) as {
  themes: Record<"dark" | "light", Record<string, string>>;
  contrast: Array<{ fg: string; bg: string; min: number }>;
};

/** The body of a top-level rule. Its selector starts a line and its closing brace sits at column 0. */
function ruleBody(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `styles.css has no top-level ${selector} rule`);
  const open = stylesheet.indexOf("{", start);
  return stylesheet.slice(open + 1, stylesheet.indexOf("\n}", open));
}

function declared(body: string, name: string): string {
  const value = body.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
  assert.ok(value, `styles.css does not declare --${name}`);
  return value;
}

const bodies = { dark: ruleBody(":root"), light: ruleBody(':root[data-theme="light"]') };

test("styles.css declares every colour in the token file with the same value, in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [name, value] of Object.entries(tokenFile.themes[theme])) {
      assert.equal(declared(bodies[theme], name).toUpperCase(), value.toUpperCase(), `${theme} --${name} must match katana-tokens.json`);
    }
  }
});

test("the thirty contrast pairs of the token file meet their minimums in both themes", () => {
  assert.equal(tokenFile.contrast.length, 30);
  for (const theme of ["dark", "light"] as const) {
    const palette = tokenFile.themes[theme];
    for (const pair of tokenFile.contrast) {
      const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
      assert.ok(ratio >= pair.min, `${theme}: ${pair.fg} on ${pair.bg} is ${ratio}:1, below ${pair.min}:1`);
    }
  }
});
