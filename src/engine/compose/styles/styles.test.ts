// The code-drawn styles: their specs refuse what would not fit or would mislead, their kits pass the engine's contract, every module is
// registered for its style, and each example spec parses.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { styleKitSchema } from "../../contracts/index.ts";
import { CODED_STYLE_KITS } from "./kits.ts";
import { CODED_STYLES, codedStyleSpecSchema, MAX_STACK_TOKENS, specProblems, STYLE_MODULES } from "./specs.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("every example spec parses, and every style has one", () => {
  const files = readdirSync(join(here, "examples")).filter((file) => file.endsWith(".json"));
  const seen = new Set<string>();
  for (const file of files) {
    const spec = codedStyleSpecSchema.parse(JSON.parse(readFileSync(join(here, "examples", file), "utf8")));
    seen.add(spec.style);
  }
  assert.deepEqual([...seen].sort(), [...CODED_STYLES].sort());
});

test("every style has a kit that passes the style kit contract, with its own id", () => {
  const ids = new Set<string>();
  for (const style of CODED_STYLES) {
    const kit = CODED_STYLE_KITS[style];
    assert.ok(styleKitSchema.safeParse(kit).success, style);
    ids.add(kit.styleKitId);
  }
  assert.equal(ids.size, CODED_STYLES.length);
});

test("every style module exists and registers itself under its style's name", () => {
  for (const style of CODED_STYLES) {
    const source = readFileSync(join(here, STYLE_MODULES[style]), "utf8");
    assert.match(source, new RegExp(`MeridianStyles\\.${style} = \\{ draw: draw, cues: cues, bed: "`), style);
    assert.doesNotMatch(source, /Math\.random|Date\.now|performance\.now/, `${style} draws as a pure function of time`);
  }
});

const chart = {
  style: "stacked_chart",
  title: "Revenue by year",
  unit: "$100K",
  perToken: 0.1,
  token: "coins",
  bars: [
    { label: "2024", value: 3.1, display: "$3.1M" },
    { label: "2025", value: 4.4, display: "$4.4M" },
  ],
  source: null,
  illustrative: true,
  takeaway: "Up again.",
  durationMs: 16000,
};

test("a chart of real figures names its source; one without a source must say it is illustrative", () => {
  assert.deepEqual(specProblems(chart), []);
  assert.match(specProblems({ ...chart, illustrative: false }).join(" "), /names its source/);
  assert.deepEqual(specProblems({ ...chart, illustrative: false, source: "Company annual report 2025" }), []);
});

test("every stack is counted, never scaled: a bar outside 1 to 48 tokens is refused", () => {
  assert.equal(MAX_STACK_TOKENS, 48);
  assert.match(specProblems({ ...chart, perToken: 0.05 }).join(" "), /between 1 and 48 tokens/);
  assert.match(specProblems({ ...chart, perToken: 10 }).join(" "), /between 1 and 48 tokens/);
});

test("text that would not fit its place, a route too long and a length off the platforms' range are refused", () => {
  const iso = JSON.parse(readFileSync(join(here, "examples", "isometric.message.json"), "utf8"));
  assert.deepEqual(specProblems(iso), []);
  assert.match(specProblems({ ...iso, title: "x".repeat(49) }).join(" "), /title/);
  assert.match(specProblems({ ...iso, stages: [...iso.stages, ...iso.stages] }).join(" "), /stages/);
  assert.match(specProblems({ ...iso, durationMs: 60000 }).join(" "), /durationMs/);
  assert.match(specProblems({ ...iso, stages: [{ ...iso.stages[0], icon: "rocket" }, iso.stages[1]] }).join(" "), /icon/);
});
