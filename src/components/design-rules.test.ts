import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The design rules of the canvas system (docs/design/KATANA_CANVAS_SYSTEM.md, owner direction 2026-11-18), checked across the app's own
// source. They describe what is drawn: a shadow only from the shadow tokens, through the surface classes; one blur; no pulse; no text under
// 11 px; corners from the one scale; and no retired class name. A rule here is a claim about the code, so a change that breaks one fails.

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

const src = fileURLToPath(new URL("../", import.meta.url));
const files = sourceFiles(src).map((path) => ({ path: path.slice(src.length), text: readFileSync(path, "utf8") }));

/** The text of every string literal in a file (quoted, single-quoted and template), so a class name is found where it is used, never in a comment. */
function literals(text: string): string {
  return [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((match) => match[0]).join("\n");
}

function offenders(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(literals(file.text))).map((file) => file.path);
}

test("no screen writes a shadow utility: a shadow comes from the surface classes and the shadow tokens", () => {
  assert.deepEqual(offenders(/(?<![\w-])(?:hover:|focus-visible:)?shadow(?:-sm|-md|-lg|-xl|-2xl)?(?![\w-])/), []);
});

test("the only blur is the navigation glass: no blur utility, and one frosted rule for the rail, the top bar and the phone bar", () => {
  assert.deepEqual(offenders(/backdrop-blur/), [], "the glass is the nav-glass class, not a utility");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const glass = css.match(/\.nav-glass \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(glass, /backdrop-filter: blur\(/);
  assert.equal((css.match(/backdrop-filter:/g) ?? []).length, 2, "the frosted rule, with its -webkit- twin, is the only one");
});

test("the meridian line is not drawn: the rail is a floating tile with its own edge, and no line crosses a page", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.site-meridian \{ display: none; \}/);
  assert.doesNotMatch(css, /\.site-meridian \{ display: block; \}|html\[data-rail\] \.site-meridian/, "nothing turns the line back on");
});

test("nothing pulses: a running state is a colour and a word, not a beat", () => {
  assert.deepEqual(offenders(/animate-pulse/), []);
});

test("no screen picks its own corner size: rounded-sharp, rounded-full and the surface classes carry the scale", () => {
  assert.deepEqual(offenders(/(?<![\w-])rounded-(?:sm|md|lg|xl|2xl|3xl)(?![\w-])/), []);
});

test("corners come from the one scale: a written radius appears only on the video canvas, and every other corner is a radius token", () => {
  assert.deepEqual(offenders(/(?<![\w-])rounded-\[(?!2px\])[^\]]+\]/).filter((path) => !/^\/?components\/canvas\//.test(path)), []);
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
    const selector = css.slice(css.lastIndexOf("}", match.index) + 1, css.lastIndexOf("{", match.index)).split("\n").pop()!.trim();
    // A corner is a radius token, 0, or the full round of a pill or a disc (9999px, what rounded-full draws).
    if (!selector.startsWith(".kc")) assert.match(match[1].trim(), /^(?:(?:var\(--radius-(?:sharp|sm|md|lg|xl)\)|0|9999px)\s*)+(?:!important)?$/, `${selector}: border-radius: ${match[1]}`);
  }
});

test("no text is smaller than 11 px", () => {
  assert.deepEqual(offenders(/text-\[10px\]/), []);
});

test("no retired class name remains: the surfaces, the text and the borders use the Katana names", () => {
  assert.deepEqual(offenders(/(?<![\w-])(?:bg|text|border|ring)-(?:surface|surface-2|fg|bg|border|accent-soft|accent-fg)(?![\w-])/), []);
  assert.deepEqual(offenders(/(?<![\w-])(?:bg|text)-(?:success|warning|danger|info)-soft(?![\w-])/), []);
  assert.deepEqual(offenders(/surface-glow|surface-overlay|attention-signal|signal-ring|signal-working|orch-node/), []);
});

test("no legacy colour variable is written in the app", () => {
  assert.deepEqual(offenders(/var\(--color-/), []);
});

test("every shadow in the stylesheet is one of the shadow tokens: the app's three, or the canvas's two", () => {
  // Owner direction 2026-11-18: a tile lifts a little, a menu more, a dialog most, and nothing glows. The video canvas (.kc) has its own two.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const match of css.matchAll(/box-shadow:\s*([^;]+);/g)) {
    const selector = css.slice(css.lastIndexOf("}", match.index) + 1, css.lastIndexOf("{", match.index)).split("\n").pop()!.trim();
    const value = match[1].trim().replace(/\s*!important/, "");
    if (/^\.kc-[a-z-]+$/.test(selector)) assert.match(value, /^var\(--kc-(?:card-)?shadow\)$/, `${selector}: box-shadow: ${value}`);
    else assert.match(value, /^(?:none|var\(--shadow-(?:sm|md|lg)\))$/, `${selector}: box-shadow: ${value}`);
  }
});

test("no infinite animation outlives reduced motion: the spinner and the running edge stop under it", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(block, /animation-iteration-count: 1 !important/);
  assert.match(block, /animation-duration: 0\.01ms !important/);
});
