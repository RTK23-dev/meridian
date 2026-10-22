import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contrastRatio } from "./lib/meridian/a11y/contrast.ts";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Design = "attentionos" | "katana";
type Theme = "dark" | "light";
const DESIGNS: Design[] = ["attentionos", "katana"];

const tokenFile = (design: Design) =>
  JSON.parse(readFileSync(new URL(`../docs/design/tokens/${design}-tokens.json`, import.meta.url), "utf8")) as {
    themes: Record<Theme, Record<string, string>>;
    shared: Record<string, string>;
    contrast: Array<{ fg: string; bg: string; min: number }>;
  };

/** The body of a top-level rule. Its selector starts a line and its closing brace sits at column 0. */
function ruleBody(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `styles.css has no top-level ${selector} rule`);
  const open = stylesheet.indexOf("{", start);
  return stylesheet.slice(open + 1, stylesheet.indexOf("\n}", open));
}

/** Every custom property a rule body declares, with its value. */
function declarations(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) values[match[1].slice(2)] = match[2].trim();
  return values;
}

/** The rule bodies of each design for each theme. Katana's rules are more specific, so they win where both apply. */
const blocks: Record<Design, Record<Theme, Record<string, string>>> = {
  attentionos: {
    dark: declarations(ruleBody(":root")),
    light: declarations(ruleBody(':root[data-theme="light"]')),
  },
  katana: {
    dark: declarations(ruleBody(':root[data-design="katana"]')),
    light: declarations(ruleBody(':root[data-design="katana"][data-theme="light"]')),
  },
};

test("each design declares every colour of its token file with the same value, in both themes", () => {
  for (const design of DESIGNS) {
    for (const theme of ["dark", "light"] as const) {
      for (const [name, value] of Object.entries(tokenFile(design).themes[theme])) {
        assert.equal(blocks[design][theme][name]?.toUpperCase(), value.toUpperCase(), `${design} ${theme} --${name} must match ${design}-tokens.json`);
      }
    }
  }
});

test("the Katana style declares every role the AttentionOS style declares, so no value leaks from one style into the other", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const name of Object.keys(blocks.attentionos[theme])) {
      assert.ok(name in blocks.katana[theme], `the Katana ${theme} rules must declare --${name}`);
    }
  }
});

test("the Katana faces, radii and motion are the values of its token file", () => {
  for (const [name, value] of Object.entries(tokenFile("katana").shared)) {
    assert.equal(blocks.katana.dark[name], value, `the Katana rules must declare --${name} as katana-tokens.json says`);
  }
});

test("the contrast pairs of each token file meet their minimums in both themes", () => {
  for (const design of DESIGNS) {
    const file = tokenFile(design);
    assert.equal(file.contrast.length, 28, `${design}-tokens.json lists 28 pairs`);
    for (const theme of ["dark", "light"] as const) {
      const palette = file.themes[theme];
      for (const pair of file.contrast) {
        const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
        assert.ok(ratio >= pair.min, `${design} ${theme}: ${pair.fg} on ${pair.bg} is ${ratio}:1, below ${pair.min}:1`);
      }
    }
  }
});

test("the AttentionOS high-contrast values stay out of the Katana style, and Katana turns off the overlay shadow", () => {
  assert.ok(stylesheet.includes(':root:not([data-theme="light"]):not([data-design="katana"])'), "the AttentionOS dark high-contrast rule excludes Katana");
  assert.ok(stylesheet.includes(':root[data-theme="light"]:not([data-design="katana"])'), "the AttentionOS light high-contrast rule excludes Katana");
  assert.ok(stylesheet.includes(':root[data-design="katana"][data-theme="light"] .surface-overlay { box-shadow: none; }'));
});

test("the Katana faces are imported by the stylesheet, since Katana is the default, and the AttentionOS faces are not", () => {
  assert.ok(stylesheet.includes('@import "@fontsource-variable/archivo";'));
  assert.ok(stylesheet.includes('@import "@fontsource-variable/instrument-sans";'));
  assert.ok(stylesheet.includes('@import "@fontsource/jetbrains-mono/400.css";'));
  assert.equal(stylesheet.includes("@fontsource-variable/inter"), false);
  assert.equal(stylesheet.includes("@fontsource-variable/sora"), false);
  assert.equal(stylesheet.includes("geist-mono"), false);
});
