import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, LOOK_PRESETS } from "../contracts/index.ts";
import { LOOK_OVERLAYS, resolveLook } from "./looks.ts";

// The overlays the compiler drew before the registry existed (contract v11). A change to any of them changes every look the compiler
// draws, so they are pinned here.
const PINNED = {
  warm: { color: "#ff8c42", blend: "overlay", opacity: 0.45 },
  cool: { color: "#3d7bd9", blend: "overlay", opacity: 0.4 },
  faded: { color: "#d8cfc4", blend: "screen", opacity: 0.25 },
  mono: { color: "#808080", blend: "saturation", opacity: 1 },
} as const;

describe("the look registry", () => {
  for (const preset of LOOK_PRESETS) {
    it(`${preset} resolves to the overlay the compiler drew before the registry`, () => {
      assert.deepEqual(resolveLook(preset), PINNED[preset]);
    });
  }

  it("has an overlay for every contract look, and for no other name", () => {
    assert.deepEqual(Object.keys(LOOK_OVERLAYS).sort(), [...LOOK_PRESETS].sort());
  });

  for (const name of ["Warm", "sepia", "", " warm", "warm ", "constructor", "__proto__", "toString"]) {
    it(`refuses ${JSON.stringify(name)}, which is not a look, and draws nothing with a guessed overlay`, () => {
      assert.throws(
        () => resolveLook(name),
        (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      );
    });
  }

  it("refuses a value that is not a string", () => {
    for (const value of [undefined, null, 1, {}]) {
      assert.throws(() => resolveLook(value), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    }
  });
});
