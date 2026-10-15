// The page's rig as the plan reads it (character.ts, Bible 13 and 9.2). A sheet drives character.rig only when it lists the rig's own
// names. The contract fixture's phoneme names (A, E, O, M, rest) are not the rig's mouth shapes, so that sheet cannot drive it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CharacterSheet } from "../contracts/index.ts";
import { characterSheetFixture } from "../contracts/fixtures/index.ts";
import { rigSheetOf, rigSheetProblem } from "./character.ts";

const RIG: CharacterSheet = {
  characterId: "char_rig",
  version: 1,
  kind: "rigged_svg",
  rigUri: "store://rigs/bean.svg",
  poses: ["idle", "point"],
  visemes: ["closed", "open", "wide", "round"],
};

const GENERATED: CharacterSheet = { characterId: "char_gen", version: 1, kind: "generated", references: ["store://gen/front.png"] };

describe("rigSheetProblem: what stops a sheet from driving character.rig", () => {
  it("accepts a rigged sheet that lists idle and the closed and open mouths", () => {
    assert.equal(rigSheetProblem(RIG), null);
  });

  it("refuses a generated sheet, a sheet with no idle pose, and a sheet with phoneme mouth names", () => {
    assert.match(rigSheetProblem(GENERATED) ?? "", /not a rigged SVG sheet/);
    assert.match(rigSheetProblem({ ...RIG, poses: ["point"] }) ?? "", /idle pose/);
    assert.match(rigSheetProblem(characterSheetFixture) ?? "", /closed and open mouth shapes/, "the contract fixture names phonemes");
  });

  it("refuses a sheet that lists no poses or no mouth shapes at all, rather than reading them as present", () => {
    assert.match(rigSheetProblem({ ...RIG, poses: undefined }) ?? "", /idle pose/);
    assert.match(rigSheetProblem({ ...RIG, visemes: undefined }) ?? "", /closed and open/);
  });
});

describe("rigSheetOf: the page's rig is the first sheet, in the order given, that can drive it", () => {
  it("skips a sheet that cannot drive the rig, and a generated sheet, to take the next rig that can", () => {
    assert.equal(rigSheetOf([GENERATED, characterSheetFixture, RIG])?.characterId, "char_rig");
  });

  it("is undefined when no sheet can drive the rig, so the type is not offered", () => {
    assert.equal(rigSheetOf([]), undefined);
    assert.equal(rigSheetOf([GENERATED, characterSheetFixture]), undefined);
  });
});
