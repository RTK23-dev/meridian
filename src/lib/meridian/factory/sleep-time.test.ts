import assert from "node:assert/strict";
import test from "node:test";
import { isValidTimeZone, localDateKey, nextNightAt, parseNightTime, sleepScheduleIdOf } from "./sleep-time.ts";

// Expected instants were worked out by hand from the zones' rules: London is on British summer time (UTC+1) until Sunday 25
// October 2026, New York is on EDT (UTC-4) until Sunday 1 November 2026, and both are standard time after those dates.

test("a night time is HH:MM on a 24-hour clock, and anything else is refused", () => {
  assert.deepEqual(parseNightTime("03:00"), { hour: 3, minute: 0 });
  assert.deepEqual(parseNightTime(" 23:59 "), { hour: 23, minute: 59 });
  assert.equal(parseNightTime("3:00"), null);
  assert.equal(parseNightTime("24:00"), null);
  assert.equal(parseNightTime("03:60"), null);
  assert.equal(parseNightTime("3pm"), null);
});

test("a time zone is valid only when the runtime knows it", () => {
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Not/A_Zone"), false);
  assert.equal(isValidTimeZone("  "), false);
});

test("the next 03:00 in London is tomorrow when today's has passed, at the summer offset", () => {
  const next = nextNightAt(new Date("2026-10-15T12:00:00Z"), "03:00", "Europe/London");
  assert.equal(next.toISOString(), "2026-10-16T02:00:00.000Z");
});

test("the next 03:00 in London is today when it has not yet come", () => {
  const next = nextNightAt(new Date("2026-10-15T01:00:00Z"), "03:00", "Europe/London");
  assert.equal(next.toISOString(), "2026-10-15T02:00:00.000Z");
});

test("after the clocks go back in London, the same local time is at the winter offset", () => {
  const next = nextNightAt(new Date("2026-10-25T12:00:00Z"), "03:00", "Europe/London");
  assert.equal(next.toISOString(), "2026-10-26T03:00:00.000Z");
});

test("New York keeps its local time across its own daylight-saving change", () => {
  assert.equal(nextNightAt(new Date("2026-10-15T12:00:00Z"), "03:00", "America/New_York").toISOString(), "2026-10-16T07:00:00.000Z");
  assert.equal(nextNightAt(new Date("2026-11-02T12:00:00Z"), "03:00", "America/New_York").toISOString(), "2026-11-03T08:00:00.000Z");
});

test("a bad time or an unknown zone throws, so a bad setting never schedules a night", () => {
  assert.throws(() => nextNightAt(new Date("2026-10-15T12:00:00Z"), "3am", "Europe/London"), /HH:MM/);
  assert.throws(() => nextNightAt(new Date("2026-10-15T12:00:00Z"), "03:00", "Not/A_Zone"), /IANA/);
});

test("the night's date is the local date, so 23:30 UTC in Tokyo is already the next day", () => {
  assert.equal(localDateKey(new Date("2026-10-15T23:30:00Z"), "Asia/Tokyo"), "2026-10-16");
  assert.equal(localDateKey(new Date("2026-10-15T23:30:00Z"), "UTC"), "2026-10-15");
});

test("the schedule id is one per workspace", () => {
  assert.equal(sleepScheduleIdOf("org_fixture"), "sleep:org_fixture");
});
