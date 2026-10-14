// Style kit to CSS custom properties (Bible 9.1 rule 4, section 13).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { styleKitFixture } from "../contracts/fixtures/index.ts";
import { MOTION_FACTORS, parseStyleKit, styleKitCss, styleKitVariables } from "./styleKit.ts";

describe("styleKitVariables", () => {
  it("maps the fixture kit to the documented custom properties, in a fixed order", () => {
    const vars = Object.fromEntries(styleKitVariables(styleKitFixture));
    assert.deepEqual(
      styleKitVariables(styleKitFixture).map(([name]) => name),
      [
        "--kit-primary",
        "--kit-secondary",
        "--kit-accent",
        "--kit-text",
        "--kit-background",
        "--kit-font-display",
        "--kit-font-body",
        "--kit-font-captions",
        "--kit-caption-highlight",
        "--kit-caption-weight",
        "--kit-caption-case",
        "--kit-motion",
      ],
    );
    assert.equal(vars["--kit-primary"], "#1B1B1B");
    assert.equal(vars["--kit-font-display"], '"Fraunces"');
    assert.equal(vars["--kit-caption-highlight"], "#FFD60A");
    assert.equal(vars["--kit-caption-weight"], "700");
    assert.equal(vars["--kit-caption-case"], "uppercase");
    assert.equal(vars["--kit-motion"], "1");
  });

  it("maps motion intensity 0 to 3 onto the factors components use", () => {
    assert.deepEqual([...MOTION_FACTORS], [0, 0.5, 1, 1.5]);
    for (const [intensity, factor] of MOTION_FACTORS.entries()) {
      const kit = { ...styleKitFixture, motionIntensity: intensity as 0 | 1 | 2 | 3 };
      assert.equal(Object.fromEntries(styleKitVariables(kit))["--kit-motion"], String(factor));
    }
  });

  it("maps sentence case to no transform", () => {
    const kit = { ...styleKitFixture, captionStyle: { ...styleKitFixture.captionStyle, case: "sentence" as const } };
    assert.equal(Object.fromEntries(styleKitVariables(kit))["--kit-caption-case"], "none");
  });

  it("is stable: the same kit gives the same CSS, byte for byte", () => {
    assert.equal(styleKitCss(styleKitFixture), styleKitCss(structuredClone(styleKitFixture)));
  });
});

describe("styleKitCss", () => {
  it("writes one :root block with every variable", () => {
    const css = styleKitCss(styleKitFixture);
    assert.ok(css.startsWith(":root {\n"));
    assert.ok(css.endsWith("}\n"));
    for (const [name, value] of styleKitVariables(styleKitFixture)) {
      assert.ok(css.includes(`  ${name}: ${value};`), `missing ${name}`);
    }
  });
});

describe("parseStyleKit", () => {
  it("accepts plain family names, including ones with spaces and digits", () => {
    for (const display of ["Fraunces", "Noto Sans JP", "Inter 2"]) {
      assert.doesNotThrow(() => parseStyleKit({ ...styleKitFixture, fonts: { ...styleKitFixture.fonts, display } }));
    }
  });

  it("refuses font names that could break out of the CSS value", () => {
    for (const display of ['Inter"; color: red', "Inter}", "Inter;", "a'b", "", " lead"]) {
      assert.throws(
        () => parseStyleKit({ ...styleKitFixture, fonts: { ...styleKitFixture.fonts, display } }),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
        `display font ${JSON.stringify(display)} should be refused`,
      );
    }
  });

  it("refuses a kit that does not match the contract", () => {
    assert.throws(
      () => parseStyleKit({ ...styleKitFixture, palette: { ...styleKitFixture.palette, primary: "red" } }),
      (error: unknown) => error instanceof EngineError && /style kit is invalid/.test(error.message),
    );
  });
});
