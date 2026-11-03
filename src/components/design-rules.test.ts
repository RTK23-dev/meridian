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

test("nothing is blurred: the header and the phone bar take the map's ground instead", () => {
  assert.deepEqual(offenders(/backdrop-blur/), []);
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
