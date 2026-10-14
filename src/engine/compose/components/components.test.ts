// Contract checks for every component in the library (Bible 9.2): props, fixtures, declared variables, and the rules
// the template must keep (seekable, clock-driven, kit colours only, no untrusted markup, no nondeterministic calls).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPONENT_LIBRARY } from "./index.ts";
import { RESERVED_PROP_DURATION, type ComponentDefinition } from "../library.ts";

const FORBIDDEN_IN_TEMPLATES: Array<[string, RegExp]> = [
  ["Math.random", /Math\.random/],
  ["Date.now", /Date\.now/],
  ["performance.now", /performance\.now/],
  ["requestAnimationFrame (wall clock, not the composition clock)", /requestAnimationFrame/],
  ["setTimeout or setInterval (wall clock)", /set(Timeout|Interval)\s*\(/],
  ["innerHTML or insertAdjacentHTML (markup from props)", /innerHTML|insertAdjacentHTML|outerHTML/],
  ["eval or new Function", /\beval\s*\(|new Function/],
  ["fetch or XMLHttpRequest (no network from a component)", /\bfetch\s*\(|XMLHttpRequest/],
  ["an infinite repeat (the timeline must be finite)", /repeat:\s*-1/],
];

/** Declared variables from the template's data-composition-variables attribute. */
function declaredIds(template: string): string[] {
  const match = /<html data-composition-variables='([^']*)'>/.exec(template);
  assert.ok(match, "the template declares its variables on <html>");
  const declarations = JSON.parse(match[1]) as Array<{ id: string; type: string }>;
  return declarations.map((declaration) => declaration.id);
}

function checkComponent(definition: ComponentDefinition): void {
  const { name, template } = definition;

  describe(name, () => {
    it("has at least three prop sets with unique names", () => {
      assert.ok(definition.fixtures.length >= 3, `has ${definition.fixtures.length} fixtures`);
      const names = definition.fixtures.map((fixture) => fixture.name);
      assert.equal(new Set(names).size, names.length);
    });

    it("validates every fixture against its schema, and keeps the golden frames inside the clip", () => {
      for (const fixture of definition.fixtures) {
        const parsed = definition.propsSchema.safeParse({ ...fixture.props, [RESERVED_PROP_DURATION]: fixture.durationMs });
        assert.ok(parsed.success, `${fixture.name}: ${parsed.success ? "" : parsed.error.message}`);
        assert.ok(fixture.framesMs.length >= 1, `${fixture.name} has no golden frame`);
        for (const frameMs of fixture.framesMs) {
          assert.ok(frameMs >= 0 && frameMs < fixture.durationMs, `${fixture.name} frame ${frameMs} ms is outside the clip`);
        }
      }
    });

    it("declares exactly its scalar props as template variables, with the schema's names", () => {
      const declared = declaredIds(template).sort();
      assert.deepEqual(declared, [...definition.declaredVariables].sort(), "declaredVariables matches the template");
      for (const fixture of definition.fixtures) {
        const parsed = definition.propsSchema.parse({ ...fixture.props, [RESERVED_PROP_DURATION]: fixture.durationMs }) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            assert.ok(declared.includes(key), `${fixture.name}: scalar prop ${key} is not declared in the template`);
          }
        }
      }
    });

    it("is a sub-composition with its own id and registers a finite GSAP timeline under that id", () => {
      assert.ok(template.includes(`data-composition-id="${name}" data-width="1080" data-height="1920"`));
      assert.ok(template.includes(`window.__timelines["${name}"] = tl;`));
      assert.ok(template.includes('gsap.timeline({ paused: true })'));
      assert.ok(template.includes("tl.set({}, {}, vars.durationMs / 1000);") || template.includes("tl.set({}, {}, seconds);"), "the timeline ends at the clip length");
    });

    it("never calls a wall-clock, random, markup or network API", () => {
      for (const [label, pattern] of FORBIDDEN_IN_TEMPLATES) {
        assert.equal(pattern.test(template), false, `${name} must not use ${label}`);
      }
    });

    it("takes its colours and fonts from the style kit, not from hard-coded values", () => {
      assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(template), false, `${name} has a hex colour`);
      const rgba = [...template.matchAll(/rgba\(([^)]*)\)/g)].map((match) => match[1]);
      for (const value of rgba) {
        assert.ok(value.startsWith("0, 0, 0,"), `${name} may only use black shadows, found rgba(${value})`);
      }
      const kitReads = [...template.matchAll(/var\(--kit-[a-z-]+\)/g)].map((match) => match[0]);
      assert.ok(kitReads.length > 0, `${name} reads the style kit`);
      assert.ok(template.includes("getComputedStyle(document.documentElement)"), `${name} reads the kit from :root`);
    });

    it("keeps user text out of markup: text is set with textContent, never by string markup", () => {
      assert.equal(/\.innerHTML\s*=|\.html\s*\(/.test(template), false);
    });
  });
}

for (const definition of Object.values(COMPONENT_LIBRARY)) {
  checkComponent(definition);
}

describe("safe zones (Bible 8.3)", () => {
  // Text boxes end at 88% of the width, so the right 12% stays clear. The bands sit below the top 10% and above
  // the bottom 20%: the lowest band (top 60% for captions, 52% for titles) keeps two or three lines inside 80%.
  for (const name of ["captions.karaoke", "title.hook", "kinetic.punchline"]) {
    it(`${name} keeps its text inside the right-hand 88% line`, () => {
      const template = COMPONENT_LIBRARY[name].template;
      assert.match(template, /left: 6%;\s*(?:\S[^;]*;\s*)*width: 82%;/, "text box spans 6% to 88%");
    });
  }

  it("keeps the lower caption and title bands above the bottom 20% line", () => {
    assert.match(COMPONENT_LIBRARY["captions.karaoke"].template, /kc-band-lower \.kc-caption \{ top: 60%; \}/);
    assert.match(COMPONENT_LIBRARY["title.hook"].template, /th-band-lower \.th-title \{ top: 52%; \}/);
  });
});

describe("component library", () => {
  it("holds the ten E1 and E2 components, each keyed by its name", () => {
    assert.deepEqual(Object.keys(COMPONENT_LIBRARY).sort(), [
      "captions.karaoke",
      "chat.thread",
      "compare.split",
      "cta.card",
      "kinetic.punchline",
      "list.tierBoard",
      "price.reveal",
      "product.card",
      "react.layout",
      "title.hook",
    ]);
    for (const [key, definition] of Object.entries(COMPONENT_LIBRARY)) {
      assert.equal(definition.name, key);
    }
  });

  it("is frozen, so a caller cannot change the library at run time", () => {
    assert.equal(Object.isFrozen(COMPONENT_LIBRARY), true);
  });
});
