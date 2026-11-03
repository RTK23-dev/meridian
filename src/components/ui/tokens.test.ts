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
  assert.ok(Object.keys(dark).length >= 16, "the dark theme defines the Katana colour roles");
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
});

test("dark is the first palette on :root, and light applies only under data-theme", () => {
  assert.equal(dark["--bg-base"], "#000000");
  assert.equal(light["--bg-base"], "#FFFFFF");
  assert.doesNotMatch(css, /\.dark\s*\{/, "the .dark class is retired; themes switch on data-theme");
  assert.match(css, /@custom-variant dark \(&:where\(:root:not\(\[data-theme="light"\]\)/);
});

test("the red accent reaches 4.5:1 as text on the page in both themes, and its label reaches 4.5:1 on the red fill", () => {
  const onDark = contrastRatio(dark["--accent-red"], dark["--bg-base"]);
  const onLight = contrastRatio(light["--accent-red"], light["--bg-base"]);
  assert.ok(onDark >= 4.5 && onLight >= 4.5, `text ${onDark}:1 dark, ${onLight}:1 light`);
  assert.ok(contrastRatio(dark["--on-accent"], dark["--accent-red"]) >= 4.5);
  assert.ok(contrastRatio(light["--on-accent"], light["--accent-red"]) >= 4.5);
});

test("the accent is a variable the reader's choice sets, and it starts as the red", () => {
  assert.equal(declarations(ruleBody(":root"))["--accent"], "var(--accent-red)");
  assert.equal(declarations(ruleBody(':root[data-theme="light"]'))["--accent-red"], "#C8102E");
});

test("the AttentionOS names are retired: the screens use the Katana role names, and no legacy alias remains", () => {
  for (const legacy of ["--color-bg", "--color-surface", "--color-surface-2", "--color-border", "--color-fg", "--color-accent-fg", "--color-accent-soft", "--color-brass-text", "--color-success-soft", "--color-paper", "--color-panel", "--color-line", "--color-muted", "--color-brass"]) {
    assert.equal(legacy in aliases, false, `${legacy} is retired`);
  }
  assert.equal(aliases["--color-fg-primary"], "var(--fg-primary)");
  assert.equal(aliases["--color-ground"], "var(--bg-base)");
  assert.equal(aliases["--color-raised"], "var(--bg-raised)");
  assert.equal(aliases["--color-overlay"], "var(--bg-overlay)");
  assert.equal(aliases["--color-on-accent"], "var(--on-accent)");
  assert.equal(aliases["--color-accent-muted"], "var(--accent-muted)");
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

test("every corner is the one Katana radius, 2 px", () => {
  for (const name of ["--radius-sharp", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"]) {
    assert.equal(aliases[name], "2px", `${name} must be 2px`);
  }
});

test("reduced motion removes movement and keeps colour fades", () => {
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /transition-property: color, background-color/);
});

test("the display face is limited to page titles and explicit opt-ins, not every heading", () => {
  assert.match(css, /h1, \.font-display \{/);
  assert.doesNotMatch(css, /h1, h2, h3 \{ font-family/);
});

test("the three Katana faces are self-hosted from public/fonts, not loaded from a package", () => {
  for (const family of ["Archivo", "Instrument Sans", "JetBrains Mono"]) {
    assert.match(css, new RegExp(`font-family: "${family}";`), `${family} has an @font-face`);
  }
  assert.doesNotMatch(css, /@fontsource/, "the fontsource packages are no longer imported");
  for (const file of ["archivo-latin.woff2", "instrument-sans-latin.woff2", "jetbrains-mono-latin.woff2"]) {
    assert.match(css, new RegExp(`/fonts/${file.replace(/\./g, "\\.")}`));
    assert.ok(statSync(fileURLToPath(new URL(`../../../public/fonts/${file}`, import.meta.url))).size > 1000, `${file} is in public/fonts`);
  }
});
