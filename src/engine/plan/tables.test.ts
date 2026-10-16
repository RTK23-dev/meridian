// The E5 tables (tables.ts): the looks of the generated types, the chains, the rig's play per beat and the stop-motion bounds.
// These tests hold the tables to the Bible's numbers (7.1, 9.2, 13) and to the gate's own text rule, so a look cannot ask for text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RIG_EXPRESSIONS, RIG_POSES, propsSchema as rigPropsSchema } from "../compose/components/character.rig/props.ts";
import { COMPONENT_LIBRARY } from "../compose/components/index.ts";
import { VISUAL_TYPES, type BeatRole } from "../contracts/index.ts";
import { promptAsksForText } from "../review/gates/promptText.ts";
import { CHAIN_TYPES } from "./chains.ts";
import {
  ARTIFACT_RISK_PRIOR,
  BUILD_GAPS,
  BUILDABLE_TYPES,
  DOWNGRADE_TO,
  PROMPT_STYLE,
  RECIPES,
  RIG_ID,
  RIG_PLAY,
  STOP_MOTION_FPS,
  STOP_MOTION_FRAMES,
  isGeneratedType,
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

describe("the chains (contract v5, chains.ts) are recipes whose calls are priced one by one (RECIPES)", () => {
  it("cartoon_generated and stop_motion are chain recipes, and the other generated types keep their single-call recipe", () => {
    assert.deepEqual(RECIPES.cartoon_generated, { kind: "chain" });
    assert.deepEqual(RECIPES.stop_motion, { kind: "chain" });
    assert.equal(RECIPES.cinematic.kind, "generate");
    assert.equal(RECIPES.product_hero.kind, "generate");
  });

  it("a chain is a generated type, so it has a prompt, a redo allowance and a fallback like any generated type", () => {
    assert.equal(isGeneratedType("cartoon_generated"), true);
    assert.equal(isGeneratedType("stop_motion"), true);
    assert.equal(isGeneratedType("stock_footage"), false);
    assert.equal(isGeneratedType("kinetic_type"), false);
    assert.equal(ARTIFACT_RISK_PRIOR.chain, ARTIFACT_RISK_PRIOR.generate);
  });

  it("the stop-motion frame bounds are Bible 7.1's: 24 to 36 frames, 8 to 12 per second", () => {
    assert.deepEqual({ ...STOP_MOTION_FRAMES }, { min: 24, max: 36 });
    assert.deepEqual({ ...STOP_MOTION_FPS }, { min: 8, max: 12 });
  });
});

describe("build gaps: the E5 types that are built, and the ones that stay gaps", () => {
  it("cartoon_generated is built now (its chain is in the source), so it is not a gap", () => {
    assert.equal(BUILD_GAPS.cartoon_generated, undefined);
    assert.ok(BUILDABLE_TYPES.includes("cartoon_generated"));
  });

  it("stop_motion has no static gap: its unknown price removes it first (rule 5), and its closing component is checked in chains.ts", () => {
    assert.equal(BUILD_GAPS.stop_motion, undefined);
    assert.ok(BUILDABLE_TYPES.includes("stop_motion"));
  });

  it("cartoon_rigged and screen_mock are built, so they are not gaps; their sources are checked per shot (sources.ts)", () => {
    assert.equal(BUILD_GAPS.cartoon_rigged, undefined);
    assert.equal(BUILD_GAPS.screen_mock, undefined);
    assert.ok(BUILDABLE_TYPES.includes("cartoon_rigged"));
    assert.ok(BUILDABLE_TYPES.includes("screen_mock"));
  });

  it("only react_clip is a static gap: every other type is buildable", () => {
    for (const type of VISUAL_TYPES) {
      assert.equal(BUILDABLE_TYPES.includes(type), type !== "react_clip", type);
    }
    assert.deepEqual([...CHAIN_TYPES].sort(), ["cartoon_generated", "stop_motion"]);
  });
});

describe("downgrade paths (Bible 7.1) for the E5 types", () => {
  it("cinematic falls back to a product hero or stock; stop_motion to a product hero; cartoon_generated to a rigged cartoon", () => {
    assert.deepEqual([...DOWNGRADE_TO.cinematic], ["product_hero", "stock_footage"]);
    assert.deepEqual([...DOWNGRADE_TO.stop_motion], ["product_hero"]);
    assert.deepEqual([...DOWNGRADE_TO.cartoon_generated], ["cartoon_rigged"]);
  });

  it("stock falls back to product_hero: the one buildable type on the video.budget class (lead decision, 2026-10-15)", () => {
    assert.deepEqual([...DOWNGRADE_TO.stock_footage], ["product_hero"]);
    const productHero = RECIPES.product_hero;
    assert.ok(productHero.kind === "generate" && productHero.modelClass === "video.budget");
    assert.ok(BUILDABLE_TYPES.includes("product_hero"));
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
