import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contrastRatio } from "../../lib/meridian/a11y/contrast.ts";

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

/** The body of a top-level rule. Its selector starts a line and its closing brace sits at column 0. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `styles.css has no top-level ${selector} rule`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("\n}", open));
}

/** Every custom property declared in a rule body, mapped to its value. */
function declarations(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) values[match[1]] = match[2].trim();
  return values;
}

/** The colour tokens of a theme: the custom properties with a literal hex or rgb value. */
function colours(body: string): Record<string, string> {
  return Object.fromEntries(Object.entries(declarations(body)).filter(([, value]) => /^(#[0-9a-fA-F]{6}|rgb\()/.test(value)));
}

const dark = colours(ruleBody(":root"));
const light = colours(ruleBody(':root[data-theme="light"]'));
const aliases = declarations(ruleBody("@theme static"));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("both themes define the same colour tokens, so no token falls back to the other theme", () => {
  assert.ok(Object.keys(dark).length >= 16, "the dark theme defines the AttentionOS colour roles");
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
});

test("dark is the default on :root, and light applies only under data-theme", () => {
  assert.equal(dark["--bg-base"], "#08070B");
  assert.equal(light["--bg-base"], "#FAF9FC");
  assert.doesNotMatch(css, /\.dark\s*\{/, "the .dark class is retired; themes switch on data-theme");
  assert.match(css, /@custom-variant dark \(&:where\(:root:not\(\[data-theme="light"\]\)/);
});

test("violet text reaches 4.5:1 on the room in both themes, and white on the violet fill reaches 4.5:1", () => {
  assert.equal(dark["--accent-text"], "#AD78FF");
  assert.equal(light["--accent-text"], "#5A1FC2");
  const onDark = contrastRatio(dark["--accent-text"], dark["--bg-base"]);
  const onLight = contrastRatio(light["--accent-text"], light["--bg-base"]);
  assert.equal(onDark, 6.61);
  assert.equal(onLight, 8.31);
  assert.equal(contrastRatio(dark["--on-accent"], dark["--accent"]), 5.95);
  assert.equal(contrastRatio(light["--on-accent"], light["--accent"]), 7.04);
  assert.ok(onDark >= 4.5 && onLight >= 4.5);
});

test("legacy names stay defined as aliases of the AttentionOS roles, so older screens keep their meaning", () => {
  assert.equal(aliases["--color-bg"], "var(--bg-base)");
  assert.equal(aliases["--color-surface"], "var(--bg-raised)");
  assert.equal(aliases["--color-surface-2"], "var(--bg-overlay)");
  assert.equal(aliases["--color-border"], "var(--border-hairline)");
  assert.equal(aliases["--color-fg"], "var(--fg-primary)");
  assert.equal(aliases["--color-accent"], "var(--accent)");
  assert.equal(aliases["--color-accent-fg"], "var(--on-accent)");
  assert.equal(aliases["--color-accent-soft"], "var(--accent-muted)");
  assert.equal(aliases["--color-brass-text"], "var(--accent-text)");
  assert.equal(aliases["--color-danger-soft"], "var(--bg-raised)");
});

test("every var(--color-*) written in the app is defined in styles.css", () => {
  const used = new Set<string>();
  for (const file of sourceFiles(fileURLToPath(new URL("../../", import.meta.url)))) {
    for (const match of readFileSync(file, "utf8").matchAll(/var\(--color-([a-z0-9-]+)\)/g)) used.add(match[1]);
  }
  const missing = [...used].filter((name) => !(`--color-${name}` in aliases));
  assert.deepEqual(missing, [], `styles.css does not define: ${missing.join(", ")}`);
});

test("no shadow token casts a shadow", () => {
  for (const name of ["--shadow-sm", "--shadow-md", "--shadow-lg"]) assert.equal(aliases[name], "0 0 #0000", `${name} must not cast a shadow`);
});

test("reduced motion removes movement and keeps colour fades", () => {
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /transition-property: color, background-color/);
});

test("the display face is limited to page titles and explicit opt-ins, not every heading", () => {
  assert.match(css, /h1, \.font-display \{/);
  assert.doesNotMatch(css, /h1, h2, h3/);
});
