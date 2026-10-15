// The E5 tables (tables.ts): the looks of the generated types, the chains, the rig's play per beat and the stop-motion bounds.
// These tests hold the tables to the Bible's numbers (7.1, 9.2, 13) and to the gate's own text rule, so a look cannot ask for text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RIG_EXPRESSIONS, RIG_POSES, propsSchema as rigPropsSchema } from "../compose/components/character.rig/props.ts";
import { COMPONENT_LIBRARY } from "../compose/components/index.ts";
import { VISUAL_TYPES, type BeatRole, type VisualType } from "../contracts/index.ts";
import { promptAsksForText } from "../review/gates/promptText.ts";
import {
  BUILD_GAPS,
  BUILDABLE_TYPES,
  DOWNGRADE_TO,
  GENERATION_CHAINS,
  PROMPT_STYLE,
  RECIPES,
  RIG_ID,
  RIG_PLAY,
  STOP_MOTION_FPS,
  STOP_MOTION_FRAMES,
} from "./tables.ts";

const BEAT_ROLES: BeatRole[] = ["hook", "setup", "item", "proof", "twist", "payoff", "cta"];

describe("the looks of the generated types name no text, price, logo or name (Bible 7.1, L8)", () => {
  for (const [type, style] of Object.entries(PROMPT_STYLE)) {
    it(`${type}: the plan gate's text rule finds nothing in the style`, () => {
      assert.equal(promptAsksForText(style).asksForText, false, `${type} style is ${JSON.stringify(promptAsksForText(style).cues)}`);
    });

    it(`${type}: the style has no price figure and no quoted words`, () => {
      assert.equal(/[$£€]\s?\d/.test(style), false);
      assert.equal(/["“‘]/.test(style), false);
    });
  }

  it("the planner's scene is the only part of a generated prompt that varies; the look is fixed in code", () => {
    assert.match(PROMPT_STYLE.cinematic, /vertical 9:16 framing/);
    assert.match(PROMPT_STYLE.cartoon_generated, /vertical 9:16 framing/);
    assert.match(PROMPT_STYLE.stop_motion, /vertical 9:16 framing/);
  });
});

describe("the rig's play (Bible 9.2): every beat plays a pose and expression the rig draws", () => {
  for (const role of BEAT_ROLES) {
    it(`${role} plays a known pose and a known expression`, () => {
      assert.ok((RIG_POSES as readonly string[]).includes(RIG_PLAY[role].pose), `${role} pose ${RIG_PLAY[role].pose}`);
      assert.ok((RIG_EXPRESSIONS as readonly string[]).includes(RIG_PLAY[role].expression), `${role} expression`);
    });
  }

  it("RIG_ID is a rig the character.rig component accepts", () => {
    const parsed = rigPropsSchema.safeParse({ rigId: RIG_ID, poses: [], mouth: [], durationMs: 1000 });
    assert.equal(parsed.success, true);
    assert.ok(COMPONENT_LIBRARY["character.rig"], "the component is in the library");
  });
});

describe("the chains (GENERATION_CHAINS) use the models the recipes price (RECIPES)", () => {
  it("cartoon_generated: the keyframe is an image call, and the video is the budget video class the recipe bills", () => {
    const [keyframe, video] = GENERATION_CHAINS.cartoon_generated;
    assert.equal(keyframe.modelClass, "image.keyframe");
    assert.equal(video.modelClass, RECIPES.cartoon_generated.kind === "generate" ? RECIPES.cartoon_generated.modelClass : "none");
    assert.equal(video.firstFrame, "the keyframe");
  });

  it("stop_motion: the frames are image.edit calls, and the recipe bills 12 frames a second (7.1's top of the range)", () => {
    const [frame, player] = GENERATION_CHAINS.stop_motion;
    const recipe = RECIPES.stop_motion;
    assert.equal(frame.modelClass, "image.edit");
    assert.ok(recipe.kind === "generate" && recipe.billing === "frame" && recipe.modelClass === frame.modelClass);
    assert.ok(recipe.kind === "generate" && recipe.billing === "frame" && recipe.framesPerSecond === STOP_MOTION_FPS.max);
    assert.equal(player.component, "stopmotion.player");
  });

  it("the stop-motion frame bounds are Bible 7.1's: 24 to 36 frames, 8 to 12 per second", () => {
    assert.deepEqual({ ...STOP_MOTION_FRAMES }, { min: 24, max: 36 });
    assert.deepEqual({ ...STOP_MOTION_FPS }, { min: 8, max: 12 });
  });
});

describe("build gaps: the E5 types that are built, and the ones that stay gaps", () => {
  it("cartoon_generated is a gap, and says why (its chain)", () => {
    assert.match(BUILD_GAPS.cartoon_generated ?? "", /chain/);
    assert.equal(BUILDABLE_TYPES.includes("cartoon_generated"), false);
  });

  it("stop_motion has no gap entry: its unknown price removes it first (rule 5), and buildSource refuses its chain", () => {
    assert.equal(BUILD_GAPS.stop_motion, undefined);
    assert.equal(RECIPES.stop_motion.kind, "generate");
  });

  it("cartoon_rigged and screen_mock stay gaps until the lead opens them, and their gap text says the source is built", () => {
    assert.match(BUILD_GAPS.cartoon_rigged ?? "", /built \(E5/);
    assert.match(BUILD_GAPS.screen_mock ?? "", /built \(E5/);
  });

  it("every type with no gap is buildable, and kinetic_type, cinematic and coded_graphics are among them", () => {
    for (const type of VISUAL_TYPES) {
      assert.equal(BUILDABLE_TYPES.includes(type), BUILD_GAPS[type] === undefined, type);
    }
    for (const type of ["kinetic_type", "cinematic", "coded_graphics", "stock_footage", "ugc_presenter", "product_hero"] as VisualType[]) {
      assert.ok(BUILDABLE_TYPES.includes(type), type);
    }
  });
});

describe("downgrade paths (Bible 7.1) for the E5 types", () => {
  it("cinematic falls back to a product hero or stock; stop_motion to a product hero; cartoon_generated to a rigged cartoon", () => {
    assert.deepEqual([...DOWNGRADE_TO.cinematic], ["product_hero", "stock_footage"]);
    assert.deepEqual([...DOWNGRADE_TO.stop_motion], ["product_hero"]);
    assert.deepEqual([...DOWNGRADE_TO.cartoon_generated], ["cartoon_rigged"]);
  });

  it("cartoon_rigged falls back to kinetic type; the code-drawn types need none", () => {
    assert.deepEqual([...DOWNGRADE_TO.cartoon_rigged], ["kinetic_type"]);
    assert.deepEqual([...DOWNGRADE_TO.kinetic_type], []);
    assert.deepEqual([...DOWNGRADE_TO.screen_mock], []);
  });

  it("every downgrade target is a real visual type", () => {
    for (const [type, targets] of Object.entries(DOWNGRADE_TO)) {
      for (const target of targets) {
        assert.ok((VISUAL_TYPES as readonly string[]).includes(target), `${type} -> ${target}`);
      }
    }
  });
});
