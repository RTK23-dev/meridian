import assert from "node:assert/strict";
import test from "node:test";
import {
  GRADUATION_NOT_DOCUMENTED,
  TRIAL_CHECK_MAX_CHECKS,
  documentedGraduationReader,
  parseTrialRequest,
  trialCheckOutcome,
  type PriorTrialState,
  type TrialReading,
} from "./trial.ts";

const prior: PriorTrialState = {
  feedStatus: "waiting",
  feedNote: "",
  feedObservedAt: null,
  observedIsSharedToFeed: null,
  checks: 0,
};

const readOk = (isSharedToFeed: boolean | null): TrialReading => ({
  ok: true,
  mediaId: "17900000000000001",
  mediaProductType: "REELS",
  isSharedToFeed,
  permalink: "https://www.instagram.com/reel/abc/",
});

test("a trial request is absent or one of the two documented strategies", () => {
  assert.deepEqual(parseTrialRequest(undefined), { ok: true, value: null });
  assert.deepEqual(parseTrialRequest(null), { ok: true, value: null });
  assert.deepEqual(parseTrialRequest({ graduationStrategy: "MANUAL" }), { ok: true, value: { graduationStrategy: "MANUAL" } });
  assert.deepEqual(parseTrialRequest({ graduationStrategy: "SS_PERFORMANCE" }), { ok: true, value: { graduationStrategy: "SS_PERFORMANCE" } });
});

test("an unknown strategy, or a value that is not an object, is refused with the reason and never coerced", () => {
  for (const value of ["MANUAL", { graduationStrategy: "manual" }, { graduationStrategy: "AUTO" }, { graduationStrategy: 1 }, [], {}]) {
    const parsed = parseTrialRequest(value);
    assert.equal(parsed.ok, false, `refused: ${JSON.stringify(value)}`);
    if (!parsed.ok) assert.match(parsed.error, /MANUAL or SS_PERFORMANCE/);
  }
});

test("the live reader never reads a graduation, whatever the reel reports", () => {
  assert.deepEqual(documentedGraduationReader(readOk(true)), { graduated: null, reason: GRADUATION_NOT_DOCUMENTED });
  assert.deepEqual(documentedGraduationReader(readOk(false)), { graduated: null, reason: GRADUATION_NOT_DOCUMENTED });
});

test("a read that shows is_shared_to_feed true is still not a graduation", () => {
  const outcome = trialCheckOutcome({ prior, reading: readOk(true), graduation: documentedGraduationReader(readOk(true)) });
  assert.equal(outcome.feedStatus, "manual_action_required");
  assert.equal(outcome.feedObservedAt, null, "no time is recorded for a graduation nobody observed");
  assert.equal(outcome.observedIsSharedToFeed, true, "the field is stored as Meta reported it");
  assert.equal(outcome.reschedule, true);
});

test("an observed graduation records the feed step with the time it was observed, and stops the checks", () => {
  const outcome = trialCheckOutcome({
    prior,
    reading: readOk(true),
    graduation: { graduated: true, observedAt: "2026-10-16T09:00:00.000Z" },
  });
  assert.equal(outcome.feedStatus, "graduated");
  assert.equal(outcome.feedObservedAt, "2026-10-16T09:00:00.000Z");
  assert.equal(outcome.lastError, "");
  assert.equal(outcome.reschedule, false);
});

test("a failed read keeps the prior feed state, records the reason, and is still counted", () => {
  const outcome = trialCheckOutcome({
    prior: { ...prior, feedStatus: "manual_action_required", feedNote: "kept", observedIsSharedToFeed: false, checks: 2 },
    reading: { ok: false, error: "Instagram refused the saved access token (HTTP 401)." },
    graduation: null,
  });
  assert.equal(outcome.feedStatus, "manual_action_required");
  assert.equal(outcome.feedNote, "kept");
  assert.equal(outcome.observedIsSharedToFeed, false, "an earlier observation is kept when the read fails");
  assert.equal(outcome.lastError, "Instagram refused the saved access token (HTTP 401).");
  assert.equal(outcome.reschedule, true);
});

test("checks stop at the limit, and the last check does not schedule another", () => {
  const beforeLast = trialCheckOutcome({
    prior: { ...prior, checks: TRIAL_CHECK_MAX_CHECKS - 2 },
    reading: readOk(false),
    graduation: documentedGraduationReader(readOk(false)),
  });
  assert.equal(beforeLast.reschedule, true);
  const last = trialCheckOutcome({
    prior: { ...prior, checks: TRIAL_CHECK_MAX_CHECKS - 1 },
    reading: readOk(false),
    graduation: documentedGraduationReader(readOk(false)),
  });
  assert.equal(last.reschedule, false);
  assert.equal(last.feedStatus, "manual_action_required", "the step stays a person's action when the checks run out");
});
