import assert from "node:assert/strict";
import test from "node:test";
import type { FormatId } from "./codex.ts";
import { BULLSEYE_WEEK, JOB_WEEK, WEEK_321, contentGrid, legoVariations, outliers, qualityPhase, repostCandidates, viewCeiling } from "./plan.ts";

const SUBTOPICS = ["pricing", "hiring", "sales calls", "cold email", "referrals", "retention"];
const FORMATS: FormatId[] = ["listicle", "s_tier_ranking", "scenario", "case_study", "epiphany"];

test("6x5: every subtopic meets every format once, and consecutive days change subtopic", () => {
  const grid = contentGrid({ method: "6x5", subtopics: SUBTOPICS, formats: FORMATS, game: "authority_services" });
  assert.equal(grid.length, 30);
  assert.equal(new Set(grid.map((slot) => `${slot.subtopic}|${slot.format}`)).size, 30);
  for (let index = 1; index < grid.length; index += 1) assert.notEqual(grid[index]!.subtopic, grid[index - 1]!.subtopic);
});

test("532: 5 subtopics x 3 formats x 2 layouts, each combination once", () => {
  const grid = contentGrid({ method: "532", subtopics: SUBTOPICS.slice(0, 5), formats: FORMATS.slice(0, 3), layouts: ["studio", "walking"], game: "education_media" });
  assert.equal(grid.length, 30);
  assert.equal(new Set(grid.map((slot) => `${slot.subtopic}|${slot.format}|${slot.layout}`)).size, 30);
});

test("331 gives nine videos; a grid refuses too few subtopics, formats or layouts", () => {
  assert.equal(contentGrid({ method: "331", subtopics: SUBTOPICS.slice(0, 3), formats: FORMATS.slice(0, 3), game: "explanatory_product" }).length, 9);
  assert.throws(() => contentGrid({ method: "6x5", subtopics: SUBTOPICS.slice(0, 2), formats: FORMATS, game: "authority_services" }), /needs 6 subtopics/);
  assert.throws(() => contentGrid({ method: "532", subtopics: SUBTOPICS, formats: FORMATS, layouts: ["one"], game: "authority_services" }), /needs 2 layouts/);
});

test("jobs follow the content game, and the ring and audience follow the job (broad to reach, narrow to convert)", () => {
  const grid = contentGrid({ method: "6x5", subtopics: SUBTOPICS, formats: FORMATS, game: "authority_services" });
  const week = grid.slice(0, 7);
  assert.deepEqual(week.map((slot) => slot.job), [...JOB_WEEK.authority_services]);
  assert.equal(week.filter((slot) => slot.job === "convert").length, 3, "3-2-2: three bullseye videos a week");
  for (const slot of grid) {
    assert.equal(slot.audience, slot.job === "convert" ? "narrow" : "broad");
    assert.ok(slot.ring >= 2, "never the broadest ring");
  }
  assert.ok(JOB_WEEK.entertainment_media.every((job) => job !== "convert"));
  assert.deepEqual([...BULLSEYE_WEEK].sort(), [2, 2, 3, 4, 5, 5, 5]);
  assert.equal(WEEK_321.length, 7);
});

const POSTS = [
  { id: "a", views: 1_000, postedAt: "2026-01-10" },
  { id: "b", views: 1_200, postedAt: "2026-02-10" },
  { id: "c", views: 900, postedAt: "2026-03-10" },
  { id: "d", views: 40_000, postedAt: "2026-04-01" },
  { id: "e", views: 1_100, postedAt: "2026-09-01" },
  { id: "f", views: 1_000, postedAt: "2026-10-01" },
  { id: "g", views: 30_000, postedAt: "2026-10-20" },
];

test("outliers are 5x the account's typical (median) views; old enough ones are repost candidates", () => {
  const found = outliers(POSTS);
  assert.deepEqual(found.map((entry) => entry.post.id), ["d", "g"], "the median is 1,100; against the mean (10,743) neither hit would count");
  assert.ok(Math.abs(found[0]!.multiple - 40_000 / 1_100) < 1e-9);
  assert.deepEqual(outliers(POSTS, 30).map((entry) => entry.post.id), ["d"]);
  assert.deepEqual(repostCandidates(POSTS, "2026-11-04").map((entry) => entry.post.id), ["d"], "g is too recent to post again");
  assert.deepEqual(outliers([{ id: "x", views: 10, postedAt: "2026-01-01" }, { id: "y", views: 30, postedAt: "2026-01-01" }], 1.4).map((entry) => entry.post.id), ["y"], "an even count takes the middle two");
  assert.deepEqual(outliers([]), []);
  assert.deepEqual(outliers([{ id: "z", views: 0, postedAt: "2026-01-01" }]), []);
});

test("Lego variations change one brick first, never return the winner, and count 3^5 - 1 with two alternatives per brick", () => {
  const winner = { topic: "pricing", angle: "raise prices", format: "scenario", hook: "contrarian", visuals: "whiteboard" };
  const alternatives = {
    topic: ["hiring", "sales calls"],
    angle: ["cut discounts", "bundle"],
    format: ["case_study", "listicle"],
    hook: ["proven_winner", "desire_outcome"],
    visuals: ["walking", "studio"],
  };
  const all = legoVariations(winner, alternatives, 1000);
  assert.equal(all.length, 3 ** 5 - 1);
  assert.equal(all[0]!.changed.length, 1);
  assert.equal(all.filter((variation) => variation.changed.length === 1).length, 10);
  assert.ok(all.every((variation) => variation.changed.length > 0));
  assert.equal(legoVariations(winner, { topic: ["pricing"] }).length, 0, "an alternative equal to the winner is not a variation");
});

test("the view ceiling names the lever, and the phase follows the number of videos posted", () => {
  assert.match(viewCeiling(400).fix, /four S's/);
  assert.match(viewCeiling(5_000).fix, /Topic selection/);
  assert.match(viewCeiling(60_000).fix, /angle/);
  assert.match(viewCeiling(400_000).fix, /Controversy/);
  assert.equal(viewCeiling(2_000_000).below, null);
  assert.deepEqual([qualityPhase(10).phase, qualityPhase(60).phase, qualityPhase(150).phase], [1, 2, 3]);
});
