import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOOK_PRESETS } from "../contracts/index.ts";
import { resolveLook } from "../compose/looks.ts";
import { OPTIONS } from "./catalog.ts";

const AVAILABLE = OPTIONS.filter((option) => option.availability.available);

describe("the repurpose catalogue", () => {
  it("names each option once", () => {
    const ids = OPTIONS.map((option) => option.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const option of AVAILABLE) {
    it(`${option.id} sets at least one part of the visual treatment, and any look it sets is in the look registry`, () => {
      const part = option.part(1);
      assert.ok(Object.keys(part).length > 0, `${option.id} sets nothing`);
      if (part.look !== undefined) resolveLook(part.look.preset);
    });
  }

  for (const preset of LOOK_PRESETS) {
    it(`the ${preset} look is offered by exactly one catalogue option`, () => {
      const offered = AVAILABLE.filter((option) => option.part(1).look?.preset === preset);
      assert.equal(offered.length, 1, `${preset} is offered by ${offered.length} options`);
    });
  }
});
