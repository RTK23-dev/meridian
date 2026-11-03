import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The design rules the redesign keeps, checked across the app's own source. They describe what is drawn: no shadow, no blur, no pulse, no
// text under 11 px, one sharp corner, and no retired class name. A rule here is a claim about the code, so a change that breaks one fails.

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

test("no shadow is drawn on any surface: a layer is a hairline edge", () => {
  assert.deepEqual(offenders(/(?<![\w-])(?:hover:|focus-visible:)?shadow(?:-sm|-md|-lg|-xl|-2xl)?(?![\w-])/), []);
});

test("the only blur is the navigation glass: no blur utility, and one frosted rule for the rail, the top bar and the phone bar", () => {
  assert.deepEqual(offenders(/backdrop-blur/), [], "the glass is the nav-glass class, not a utility");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const glass = css.match(/\.nav-glass \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(glass, /backdrop-filter: blur\(/);
  assert.equal((css.match(/backdrop-filter:/g) ?? []).length, 2, "the frosted rule, with its -webkit- twin, is the only one");
});

test("the meridian is the rail's edge on desktop, and no line is drawn in the middle of a page", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const meridian = css.match(/\.site-meridian \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(meridian, /display: none;/, "hidden unless a rail is on the page");
  assert.doesNotMatch(meridian, /left: 50%/, "never at the middle of the window");
  assert.match(css, /html\[data-rail="expanded"\] \{ --rail-edge: 232px; \}/);
  assert.match(css, /html\[data-rail="collapsed"\] \{ --rail-edge: 64px; \}/);
});

test("nothing pulses: a running state is a colour and a word, not a beat", () => {
  assert.deepEqual(offenders(/animate-pulse/), []);
});

test("every corner is the one sharp radius, so no rounded-md, -lg, -xl or -2xl remains", () => {
  assert.deepEqual(offenders(/(?<![\w-])rounded-(?:sm|md|lg|xl|2xl|3xl)(?![\w-])/), []);
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

test("the stylesheet casts no shadow: every box-shadow is none", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const match of css.matchAll(/box-shadow:\s*([^;]+);/g)) assert.equal(match[1].trim().replace(/\s*!important/, ""), "none", `box-shadow: ${match[1]}`);
});

test("no infinite animation outlives reduced motion: the spinner and the running edge stop under it", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(block, /animation-iteration-count: 1 !important/);
  assert.match(block, /animation-duration: 0\.01ms !important/);
});
