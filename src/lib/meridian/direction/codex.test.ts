import assert from "node:assert/strict";
import test from "node:test";
import { getBibleEntryBySlug } from "../study/bible.ts";
import {
  AI_WEAK_SPOTS,
  DIRECTION_CODEX_VERSION,
  FORMAT_LEVELS,
  LOCK_IN_APPROACHES,
  STRATEGY_RULES,
  TRUST_ANCHOR_TYPES,
  VIDEO_JOBS,
  VIEW_CEILINGS,
  VIRALITY_STACK,
  CHECK_IDS,
  EMOTIONS,
  EMOTION_IDS,
  FORMAT_ARCHETYPES,
  FORMAT_IDS,
  HOOK_FAMILIES,
  HOOK_FAMILY_IDS,
  NICHE_FAMILIES,
  NICHE_PROFILES,
  REWATCH_DEVICES,
  REWATCH_DEVICE_IDS,
  RUBRIC,
  RUBRIC_IDS,
  SHARE_TRIGGERS,
  SHARE_TRIGGER_IDS,
  leanInScore,
} from "./codex.ts";

test("every list in the codex covers its ids exactly once", () => {
  const same = (label: string, ids: readonly string[], entries: readonly { id: string }[]) =>
    assert.deepEqual(
      entries.map((entry) => entry.id),
      [...ids],
      `${label}: one entry per id, in id order`,
    );
  same("hook families", HOOK_FAMILY_IDS, HOOK_FAMILIES);
  same("formats", FORMAT_IDS, FORMAT_ARCHETYPES);
  same("emotions", EMOTION_IDS, EMOTIONS);
  same("share triggers", SHARE_TRIGGER_IDS, SHARE_TRIGGERS);
  same("rewatch devices", REWATCH_DEVICE_IDS, REWATCH_DEVICES);
  same("rubric", RUBRIC_IDS, RUBRIC);
  same("niches", NICHE_FAMILIES, NICHE_PROFILES);
});

test("each format skeleton tiles the whole duration, opens on a hook and pays off in its last part", () => {
  for (const format of FORMAT_ARCHETYPES) {
    assert.equal(format.beats[0]?.role, "hook", `${format.id} opens on a hook`);
    assert.equal(format.beats[0]?.from, 0, `${format.id} starts at 0`);
    assert.equal(format.beats.at(-1)?.to, 1, `${format.id} ends at 1`);
    for (let index = 1; index < format.beats.length; index += 1) {
      assert.equal(format.beats[index]?.from, format.beats[index - 1]?.to, `${format.id} beat ${index} starts where the one before ends`);
    }
    const payoff = format.beats.find((beat) => beat.role === "payoff");
    assert.ok(payoff && payoff.from >= 0.5, `${format.id} pays off after the midpoint`);
  }
});

test("the rubric's prior weights sum to 1, and the Lean-In Score runs from 0 to 100", () => {
  const sum = RUBRIC.reduce((total, dimension) => total + dimension.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  assert.equal(leanInScore({}), 0);
  assert.equal(leanInScore(Object.fromEntries(RUBRIC_IDS.map((id) => [id, 4]))), 100);
  assert.equal(leanInScore({ stop_frame: 9, promise: -3, gap: Number.NaN }), 10, "out-of-range scores are clamped; a non-number counts as 0");
});

test("a hook family's Angle Bible slug names a real entry of the study framework", () => {
  for (const family of HOOK_FAMILIES) {
    if (family.angleBibleSlug === undefined) continue;
    assert.ok(getBibleEntryBySlug(family.angleBibleSlug), `${family.id} maps to ${family.angleBibleSlug}`);
  }
});

test("niche profiles name only codex ids, and each weak spot's checks are real check ids", () => {
  const families = new Set<string>(HOOK_FAMILY_IDS);
  const emotions = new Set<string>(EMOTION_IDS);
  for (const profile of NICHE_PROFILES) {
    for (const id of profile.hookFamilies) assert.ok(families.has(id), `${profile.id}: ${id}`);
    for (const id of profile.emotions) assert.ok(emotions.has(id), `${profile.id}: ${id}`);
  }
  const checks = new Set<string>(CHECK_IDS);
  for (const spot of AI_WEAK_SPOTS) for (const check of spot.checks) assert.ok(checks.has(check), `${spot.id}: ${check}`);
  assert.equal(AI_WEAK_SPOTS.length, 17);
});

test("version 2 carries the lessons: every format sits on the format pyramid, and the new lists are complete", () => {
  assert.equal(DIRECTION_CODEX_VERSION, "direction-codex@2");
  for (const format of FORMAT_ARCHETYPES) assert.ok(FORMAT_LEVELS.includes(format.level), format.id);
  for (const level of FORMAT_LEVELS) assert.ok(FORMAT_ARCHETYPES.some((format) => format.level === level), `${level} has a format`);
  assert.deepEqual([...TRUST_ANCHOR_TYPES], ["direct_results", "effort_maxing", "credibility", "association"], "strongest first");
  assert.equal(LOCK_IN_APPROACHES.length, 6);
  assert.deepEqual(Object.keys(VIRALITY_STACK), [...VIDEO_JOBS]);
  assert.ok(Object.values(VIRALITY_STACK).every((entry) => entry.angle === "non_obvious"), "the non-obvious angle is in every job");
  assert.deepEqual(VIEW_CEILINGS.map((ceiling) => ceiling.below), [1_000, 10_000, 100_000, 1_000_000]);
  assert.ok(STRATEGY_RULES.some((rule) => rule.id === "one_job"));
});

test("a listicle pays its best points first; a ranking holds its top back for the end", () => {
  const listicle = FORMAT_ARCHETYPES.find((format) => format.id === "listicle")!;
  const ranking = FORMAT_ARCHETYPES.find((format) => format.id === "s_tier_ranking")!;
  assert.match(listicle.beats[2]!.job, /best point first/);
  assert.match(ranking.beats.at(-1)!.job, /S tier, revealed last/);
});
