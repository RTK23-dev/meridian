import assert from "node:assert/strict";
import test from "node:test";
import {
  isIanaTimeZone,
  pageFieldsProblem,
  pageRequestKits,
  parseNewThemePage,
  parsePostingTimes,
  parseThemePageFields,
  storedPostingTimes,
  trialChoiceFor,
} from "./model.ts";

test("a new page needs a name and a platform, and every other field starts unknown or off", () => {
  assert.deepEqual(parseNewThemePage({}), { ok: false, error: "The page needs a name." });
  assert.deepEqual(parseNewThemePage({ name: "Launch" }), { ok: false, error: "Choose the platform for the page." });
  const created = parseNewThemePage({ name: "  Launch  ", platform: "instagram" });
  assert.deepEqual(created, {
    ok: true,
    value: {
      name: "Launch",
      niche: null,
      platform: "instagram",
      platformAccountId: null,
      personaKitId: null,
      voiceKitId: null,
      styleKitId: null,
      postingTimeZone: null,
      postingTimes: null,
      trialFirst: false,
      trialGraduation: null,
      status: "active",
    },
  });
});

test("an empty text field is unknown (null), not a blank value", () => {
  const parsed = parseThemePageFields({ niche: "   ", personaKitId: "", postingTimeZone: "" });
  assert.deepEqual(parsed, { ok: true, value: { niche: null, personaKitId: null, postingTimeZone: null } });
});

test("a platform outside the four organic platforms is refused, and so is a page named with a number", () => {
  assert.equal(parseThemePageFields({ platform: "meta_ads" }).ok, false);
  assert.equal(parseThemePageFields({ platform: "Instagram" }).ok, false);
  assert.equal(parseThemePageFields({ name: 42 }).ok, false);
});

test("a time zone must be a zone the runtime knows, and no zone is assumed", () => {
  assert.equal(isIanaTimeZone("Europe/London"), true);
  assert.equal(isIanaTimeZone("America/New_York"), true);
  assert.equal(isIanaTimeZone("Mars/Olympus"), false);
  assert.equal(parseThemePageFields({ postingTimeZone: "Mars/Olympus" }).ok, false);
  assert.deepEqual(parseThemePageFields({ postingTimeZone: "Europe/London" }), { ok: true, value: { postingTimeZone: "Europe/London" } });
});

test("posting times are HH:MM per weekday, sorted and without duplicates, and an empty schedule is no schedule", () => {
  assert.deepEqual(parsePostingTimes({ mon: ["18:30", "09:00", "09:00"], sun: [] }), {
    ok: true,
    value: { mon: ["09:00", "18:30"] },
  });
  assert.deepEqual(parsePostingTimes({ mon: [], tue: [] }), { ok: true, value: null });
  assert.deepEqual(parsePostingTimes(null), { ok: true, value: null });
});

test("a time that is not HH:MM, a day that is not a weekday and a list too long are each refused", () => {
  for (const bad of [{ mon: ["9:30"] }, { mon: ["24:00"] }, { mon: ["12:60"] }, { mon: ["noon"] }, { funday: ["09:00"] }, { mon: "09:00" }]) {
    assert.equal(parsePostingTimes(bad).ok, false, JSON.stringify(bad));
  }
  const tooMany = { mon: Array.from({ length: 13 }, (_, index) => `${String(index).padStart(2, "0")}:00`) };
  assert.equal(parsePostingTimes(tooMany).ok, false);
});

test("the trial graduation must be one of the two documented strategies, or none", () => {
  assert.deepEqual(parseThemePageFields({ trialGraduation: "MANUAL" }), { ok: true, value: { trialGraduation: "MANUAL" } });
  assert.deepEqual(parseThemePageFields({ trialGraduation: null }), { ok: true, value: { trialGraduation: null } });
  assert.equal(parseThemePageFields({ trialGraduation: "manual" }).ok, false);
  assert.equal(parseThemePageFields({ trialFirst: "yes" }).ok, false);
});

test("an edit cannot retire a page: archived is refused as a status, and archiving is its own action", () => {
  assert.equal(parseThemePageFields({ status: "archived" }).ok, false);
  assert.deepEqual(parseThemePageFields({ status: "paused" }), { ok: true, value: { status: "paused" } });
});

test("a schedule with no time zone, and a trial first with no graduation, are refused together", () => {
  assert.match(
    pageFieldsProblem({ postingTimes: { mon: ["09:00"] }, postingTimeZone: null, trialFirst: false, trialGraduation: null }) ?? "",
    /needs a time zone/,
  );
  assert.match(
    pageFieldsProblem({ postingTimes: null, postingTimeZone: null, trialFirst: true, trialGraduation: null }) ?? "",
    /needs a graduation strategy/,
  );
  assert.equal(
    pageFieldsProblem({ postingTimes: { mon: ["09:00"] }, postingTimeZone: "Europe/London", trialFirst: true, trialGraduation: "MANUAL" }),
    null,
  );
});

test("the request's page fields come from the page's own kits, and an unset kit stays null", () => {
  const kits = pageRequestKits({
    id: "page-1",
    styleKitId: "style-kit-9",
    personaKitId: null,
    voiceKitId: "voice-kit-2",
  });
  assert.deepEqual(kits, { pageId: "page-1", styleKitId: "style-kit-9", personaId: null, voiceId: "voice-kit-2" });
});

test("a page's trial default is its strategy when trial first is on, and nothing otherwise", () => {
  assert.deepEqual(trialChoiceFor({ trialFirst: true, trialGraduation: "SS_PERFORMANCE" }), { graduationStrategy: "SS_PERFORMANCE" });
  assert.equal(trialChoiceFor({ trialFirst: false, trialGraduation: "MANUAL" }), null);
  assert.equal(trialChoiceFor({ trialFirst: true, trialGraduation: null }), null);
});

test("a stored schedule that is not valid is read as no schedule, never as a guess", () => {
  assert.deepEqual(storedPostingTimes('{"mon":["09:00"]}'), { mon: ["09:00"] });
  assert.equal(storedPostingTimes("not json"), null);
  assert.equal(storedPostingTimes({ mon: ["25:00"] }), null);
  assert.equal(storedPostingTimes(null), null);
});
