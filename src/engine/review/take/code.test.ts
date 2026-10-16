import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { codeRows, CODE_RULES, type CodeShot } from "./code.ts";
import { fixture } from "../test/helpers.ts";

type Measurements = { durationMs: number | null; blackOrFrozenRunFrames: number | null; flickerScore: number | null; meanMotion: number | null };

const moving: CodeShot = { plannedDurationMs: 4000, motionRequired: true };
const still: CodeShot = { plannedDurationMs: 4000, motionRequired: false };

const recorded = fixture<Record<string, Measurements>>("take-measurements");

function clean(overrides: Partial<Measurements> = {}): Measurements {
  return { durationMs: 4000, blackOrFrozenRunFrames: 0, flickerScore: 0.1, meanMotion: 0.22, ...overrides };
}

function rowOf(rows: ReturnType<typeof codeRows>, rule: string) {
  const row = rows.find((item) => item.check.rule === rule);
  assert.ok(row, `no row for ${rule}`);
  return row;
}

describe("take code checks (Bible 6.7 step 1, 12.2)", () => {
  it("a clean recorded take passes every code check", () => {
    const rows = codeRows(moving, recorded.clean);
    assert.deepEqual(
      rows.map((row) => [row.check.rule, row.check.pass]),
      [
        [CODE_RULES.duration, true],
        [CODE_RULES.blackFrames, true],
        [CODE_RULES.flicker, true],
        [CODE_RULES.motion, true],
      ],
    );
    assert.ok(rows.every((row) => row.evidence === "measured"));
  });

  it("duration is within the tolerance share of the shot, inclusive at the edge and failing just past it", () => {
    const tolerance = thresholds.take.durationTolerance.value;
    const planned = 4000;
    const edgeMs = planned * (1 + tolerance);
    assert.equal(rowOf(codeRows(moving, clean({ durationMs: edgeMs })), CODE_RULES.duration).check.pass, true);
    assert.equal(rowOf(codeRows(moving, clean({ durationMs: edgeMs + 1 })), CODE_RULES.duration).check.pass, false);
    const shortEdge = planned * (1 - tolerance);
    assert.equal(rowOf(codeRows(moving, clean({ durationMs: shortEdge })), CODE_RULES.duration).check.pass, true);
    assert.equal(rowOf(codeRows(moving, clean({ durationMs: shortEdge - 1 })), CODE_RULES.duration).check.pass, false);
  });

  it("the recorded take 17 per cent longer than its shot fails the duration check, with its value and limit", () => {
    const row = rowOf(codeRows(moving, recorded.too_long), CODE_RULES.duration);
    assert.equal(row.check.pass, false);
    assert.equal(row.check.limit, thresholds.take.durationTolerance.value);
    assert.ok((row.check.value ?? 0) > thresholds.take.durationTolerance.value);
    assert.equal(row.evidence, "measured");
  });

  it("a run of black or frozen frames passes up to the limit (2 frames) and fails above it", () => {
    const limit = thresholds.take.blackOrFrozenFramesMax.value;
    assert.equal(rowOf(codeRows(moving, clean({ blackOrFrozenRunFrames: limit })), CODE_RULES.blackFrames).check.pass, true);
    assert.equal(rowOf(codeRows(moving, clean({ blackOrFrozenRunFrames: limit + 1 })), CODE_RULES.blackFrames).check.pass, false);
    const blackRow = rowOf(codeRows(moving, recorded.black_frames), CODE_RULES.blackFrames);
    assert.equal(blackRow.check.pass, false);
    assert.equal(blackRow.check.value, 5);
  });

  it("flicker must be strictly below its limit", () => {
    const limit = thresholds.take.flickerMax.value;
    assert.equal(rowOf(codeRows(moving, clean({ flickerScore: limit - 0.01 })), CODE_RULES.flicker).check.pass, true);
    assert.equal(rowOf(codeRows(moving, clean({ flickerScore: limit })), CODE_RULES.flicker).check.pass, false);
    assert.equal(rowOf(codeRows(moving, recorded.flicker), CODE_RULES.flicker).check.pass, false);
  });

  it("motion must be strictly above its limit for a shot that must move", () => {
    const limit = thresholds.take.motionMin.value;
    assert.equal(rowOf(codeRows(moving, clean({ meanMotion: limit })), CODE_RULES.motion).check.pass, false);
    assert.equal(rowOf(codeRows(moving, clean({ meanMotion: limit + 0.01 })), CODE_RULES.motion).check.pass, true);
    const still1 = rowOf(codeRows(moving, recorded.static_motion_shot), CODE_RULES.motion);
    assert.equal(still1.check.pass, false);
  });

  it("the motion check is not run for a shot that does not have to move", () => {
    const rows = codeRows(still, recorded.static_motion_shot);
    assert.equal(rows.some((row) => row.check.rule === CODE_RULES.motion), false);
    assert.equal(rows.every((row) => row.check.pass), true);
  });
});

describe("take code checks: missing evidence is review, never pass", () => {
  it("a take with no measured duration fails its duration check as not evaluated, and says why", () => {
    const row = rowOf(codeRows(moving, recorded.probe_missing), CODE_RULES.duration);
    assert.equal(row.check.pass, false);
    assert.equal(row.evidence, "missing");
    assert.match(row.check.detail ?? "", /^not evaluated: /);
    assert.equal(row.gold, "take:duration_within_tolerance");
  });

  it("each null measurement is a missing row that fails, for every code check", () => {
    for (const field of ["blackOrFrozenRunFrames", "flickerScore", "meanMotion"] as const) {
      const rows = codeRows(moving, clean({ [field]: null } as Partial<Measurements>));
      const missing = rows.filter((row) => row.evidence === "missing");
      assert.equal(missing.length, 1, field);
      assert.equal(missing[0]?.check.pass, false, field);
    }
  });

  it("a measurement object that does not parse makes every code check missing, so no check runs on a guess", () => {
    const rows = codeRows(moving, { durationMs: -4, blackOrFrozenRunFrames: 0, flickerScore: 0.1, meanMotion: 0.2 });
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.evidence === "missing" && row.check.pass === false));
    assert.match(rows[0]?.check.detail ?? "", /measurements do not parse/);
  });

  it("a missing object (undefined) is missing evidence for every code check", () => {
    const rows = codeRows(still, undefined);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.evidence === "missing"));
  });

  it("a non-finite flicker score is refused, not treated as a value", () => {
    const rows = codeRows(still, clean({ flickerScore: Number.NaN }));
    assert.equal(rowOf(rows, CODE_RULES.flicker).evidence, "missing");
  });
});
