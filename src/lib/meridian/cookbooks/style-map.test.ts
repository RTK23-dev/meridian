// Decision 5: the cookbook decides a run's style, and a style filter offers the cookbooks that carry it. These tests hold the table to the
// library: every brief style is in the family table, every built-in cookbook that has a style is in the family it names, and the gaps are the
// styles no built-in carries (a new cookbook for one of them changes the expected gaps here, on purpose).

import assert from "node:assert/strict";
import { test } from "node:test";
import { STYLE_PRESETS } from "../content-factory/style-presets.ts";
import { builtinCookbooks } from "./builtin/index.ts";
import {
  BRIEF_STYLE_IDS,
  COOKBOOK_STYLE,
  STYLE_FAMILY,
  cookbooksForStyle,
  coveredStyles,
  isBriefStyleId,
  styleGaps,
  styleLabel,
  styleOfCookbook,
} from "./style-map.ts";

test("the style table names every brief style the Batch offers, and only those", () => {
  assert.deepEqual([...BRIEF_STYLE_IDS].sort(), STYLE_PRESETS.map((preset) => preset.id).sort());
  assert.deepEqual(Object.keys(STYLE_FAMILY).sort(), [...BRIEF_STYLE_IDS].sort());
});

test("every built-in cookbook that has a style is in the family the table names for that style", () => {
  for (const cookbook of builtinCookbooks()) {
    const style = styleOfCookbook(cookbook);
    if (style === null) continue;
    assert.equal(cookbook.family, STYLE_FAMILY[style], `${cookbook.cookbookId} is in ${cookbook.family}, but ${style} belongs to ${STYLE_FAMILY[style]}`);
  }
});

test("the built-in cookbooks carry seven styles; one style has no cookbook yet, and it is the gap the Batch refuses", () => {
  const cookbooks = builtinCookbooks();
  assert.deepEqual(coveredStyles(cookbooks), ["product_promo", "explainer", "talking_head", "ugc_style", "cinematic_story", "motion_graphics", "tips_list"]);
  assert.deepEqual(styleGaps(cookbooks), ["fast_cut_short"]);
});

test("a blank cookbook has no style, so no style filter offers it", () => {
  const blanks = builtinCookbooks().filter((cookbook) => cookbook.cookbookId.startsWith("ck_blank_"));
  assert.equal(blanks.length, 3);
  for (const blank of blanks) assert.equal(styleOfCookbook(blank), null, `${blank.cookbookId} has no style`);
  for (const style of BRIEF_STYLE_IDS) {
    assert.ok(cookbooksForStyle(style, blanks).length === 0, `no blank cookbook is offered for ${style}`);
  }
});

test("a style filter returns the cookbooks of that style, and none of another", () => {
  const cookbooks = builtinCookbooks();
  assert.deepEqual(
    cookbooksForStyle("explainer", cookbooks).map((cookbook) => cookbook.cookbookId),
    ["ck_3d_data_explainer", "ck_isometric_explainer", "ck_line_diagram", "ck_pixel_explainer", "ck_factory_strict_quality"],
  );
  assert.deepEqual(cookbooksForStyle("ugc_style", cookbooks).map((cookbook) => cookbook.cookbookId), ["ck_ugc_product", "ck_factory_viral_ugc"]);
  assert.deepEqual(cookbooksForStyle("cinematic_story", cookbooks).map((cookbook) => cookbook.cookbookId), ["ck_paper_cut_story"]);
  assert.deepEqual(cookbooksForStyle("fast_cut_short", cookbooks), [], "a gap offers nothing, and the Batch says so");
});

test("a cookbook outside the built-ins takes its style from its family when only one style shares the family, and has none when two do", () => {
  // A story cookbook made in the workspace: one style (cinematic story) is in the story family, so it has that style.
  assert.equal(styleOfCookbook({ cookbookId: "ck_workspace_story", family: "story" }), "cinematic_story");
  // The listicle family has two styles, so a workspace listicle with no explicit entry has none until it is given one.
  assert.equal(styleOfCookbook({ cookbookId: "ck_workspace_list", family: "listicle" }), null);
  // An explicit entry always wins over the family rule.
  assert.equal(styleOfCookbook({ cookbookId: "ck_voice_listicle", family: "listicle" }), COOKBOOK_STYLE.ck_voice_listicle);
});

test("a style's label is the label the Batch shows, and an unknown value is not a style", () => {
  assert.equal(styleLabel("tips_list"), "Tips list");
  assert.equal(isBriefStyleId("explainer"), true);
  assert.equal(isBriefStyleId("super"), false, "the modes are not styles");
  assert.equal(isBriefStyleId("orchestrator"), false);
});
