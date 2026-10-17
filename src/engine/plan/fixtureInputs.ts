// Planner inputs built from the contracts fixture chain, for tests. The shot alignment is written by hand here, as the
// reference alignment (6.4 step 1) would give it: shots 1 to 5 sit in reference segments 1 to 4. Not used in production.

import type { ReferenceShotType, VisualType } from "../contracts/index.ts";
import { FIXTURE_IDS, productionRequestFixture } from "../contracts/fixtures/index.ts";
import type { VisualDecisionInput } from "./visual.ts";
import type { ClassifiedRequest, PlanKits, ShotInput } from "./types.ts";
import { scriptOf } from "../script/resolve.ts";

const NO_FLAGS = { textInPixels: false, handsOnProduct: false, showsProduct: false };

/** The must request of beat b3, classified by hand as real_product (E3's Claude call does this later). */
export const blenderMust: ClassifiedRequest = {
  strength: "must",
  want: "the blender on a clean kitchen counter",
  properties: ["real_product"],
};

export function fixtureShots(): ShotInput[] {
  const beats = scriptOf(productionRequestFixture, null).beats;
  const roleOf = (beatId: string) => beats.find((beat) => beat.beatId === beatId)?.role ?? "setup";
  const spec: { shotId: string; beatId: string; refShot: ReferenceShotType; startMs: number; endMs: number }[] = [
    { shotId: FIXTURE_IDS.shot1, beatId: "b1", refShot: "talking_head", startMs: 0, endMs: 3000 },
    { shotId: FIXTURE_IDS.shot2, beatId: "b2", refShot: "broll_montage", startMs: 3000, endMs: 9000 },
    { shotId: FIXTURE_IDS.shot3, beatId: "b3", refShot: "product_closeup", startMs: 9000, endMs: 15000 },
    { shotId: FIXTURE_IDS.shot4, beatId: "b4", refShot: "onscreen_list", startMs: 15000, endMs: 21000 },
    { shotId: FIXTURE_IDS.shot5, beatId: "b5", refShot: "onscreen_list", startMs: 21000, endMs: 24000 },
  ];
  return spec.map((item) => ({
    shotId: item.shotId,
    beatId: item.beatId,
    beatRole: roleOf(item.beatId),
    refShot: item.refShot,
    startMs: item.startMs,
    endMs: item.endMs,
    flags: item.beatId === "b3" ? { ...NO_FLAGS, showsProduct: true } : { ...NO_FLAGS },
    requests: item.beatId === "b3" ? [blenderMust] : [],
  }));
}

export const fixtureKits: PlanKits = {
  persona: true,
  rigCharacter: true,
  generatedCharacter: false,
  productKit: true,
};

export const fixtureStyle = {
  preferredTypes: ["ugc_presenter", "product_hero", "coded_graphics"] as VisualType[],
  bannedTypes: ["cartoon_generated"] as VisualType[],
};

/** The fixture request at a given budget, with the fixture shots and kits. */
export function fixtureDecisionInput(requestBudgetUsd: number): VisualDecisionInput {
  return {
    shots: fixtureShots(),
    styleKit: fixtureStyle,
    kits: fixtureKits,
    requestBudgetUsd,
  };
}
