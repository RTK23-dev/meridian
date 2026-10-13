import assert from "node:assert/strict";
import test from "node:test";
import { COUNTRY_CODES, isCountryCode } from "./country-codes.ts";
import { DEFAULT_RUN_SETTINGS, parseRunSettings, parseTargetingCountries } from "./run-settings.ts";
import {
  checkedDefaults,
  countriesFromText,
  draftFromDefaults,
  draftProblems,
  paidCountryNote,
  settingsFromDraft,
  type BuilderDraft,
} from "./run-builder-model.ts";
import { liveRouteFor, NO_PAGE_OR_LINK_REASON, NO_TARGETING_COUNTRY_REASON } from "./publish.ts";
import { metaPublishEngine, publishEngineById } from "../publishing/engine.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";

const READY: BuilderDraft = {
  ...draftFromDefaults(DEFAULT_RUN_SETTINGS),
  niche: "skincare",
  formats: ["image"],
};

test("the country list is the ISO 3166-1 alpha-2 list of officially assigned codes", () => {
  assert.equal(COUNTRY_CODES.size, 249);
  for (const code of ["US", "GB", "DE", "CA", "JP"]) assert.equal(isCountryCode(code), true, code);
  // XK is user-assigned, UK and EU are not codes, and a lowercase code is not coerced.
  for (const code of ["XK", "UK", "EU", "ZZ", "us", ""]) assert.equal(isCountryCode(code), false, code);
});

test("targeting countries accept valid codes, collapse duplicates and keep the order given", () => {
  assert.deepEqual(parseTargetingCountries(["US", "GB", "US"]), { ok: true, value: ["US", "GB"] });
  assert.deepEqual(parseTargetingCountries([]), { ok: true, value: [] }, "no countries is a valid setting; a live paid publish refuses it");
});

test("targeting countries refuse an unknown code, a lowercase code and an empty entry, each with its reason", () => {
  const unknown = parseTargetingCountries(["ZZ"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /ZZ is not an ISO 3166-1 country code/);

  const lowercase = parseTargetingCountries(["us"]);
  assert.equal(lowercase.ok, false);
  if (!lowercase.ok) assert.match(lowercase.error, /Write it in capitals: US/);

  const empty = parseTargetingCountries(["US", "  "]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /empty/);

  const notAList = parseTargetingCountries("US");
  assert.equal(notAList.ok, false);
  if (!notAList.ok) assert.match(notAList.error, /list of two-letter country codes/);

  const tooMany = parseTargetingCountries(Array.from({ length: 26 }, () => "US"));
  assert.equal(tooMany.ok, false);
});

test("run settings take targeting countries, lay them over the defaults, and refuse a bad one", () => {
  assert.deepEqual(DEFAULT_RUN_SETTINGS.targetingCountries, []);
  const accepted = parseRunSettings({ targetingCountries: ["CA", "US"] });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.value.targetingCountries, ["CA", "US"]);
  const refused = parseRunSettings({ targetingCountries: ["ZZ"] });
  assert.equal(refused.ok, false, "a run cannot store an unknown country");
});

test("the builder reads a typed country list and reports an invalid one as a problem that stops the run", () => {
  assert.deepEqual(countriesFromText("US, GB  DE"), { ok: true, value: ["US", "GB", "DE"] });
  assert.deepEqual(countriesFromText("   "), { ok: true, value: [] });

  const problems = draftProblems({ ...READY, countries: "US, gb" });
  assert.ok(problems.some((item) => /Write it in capitals: GB/.test(item)), problems.join(" | "));

  assert.deepEqual(settingsFromDraft({ ...READY, countries: "US, GB" }).targetingCountries, ["US", "GB"]);
  assert.deepEqual(draftFromDefaults({ ...DEFAULT_RUN_SETTINGS, targetingCountries: ["US", "CA"] }).countries, "US, CA");
});

test("a paid run with no country says the paid publish will be refused, and an organic run or a set country says nothing", () => {
  assert.match(paidCountryNote("ad", ""), /no targeting country/);
  assert.match(paidCountryNote("both", "  "), /no targeting country/);
  assert.equal(paidCountryNote("organic", ""), "");
  assert.equal(paidCountryNote("ad", "US"), "");
  assert.equal(paidCountryNote("ad", "us"), "", "an invalid list has its own message, so no second note is shown");
});

test("brand defaults save only settings that pass the server's checks, and a niche is not needed for them", () => {
  const saved = checkedDefaults({ ...READY, niche: "", countries: "US" });
  assert.equal(saved.ok, true);
  if (saved.ok) assert.deepEqual(saved.settings.targetingCountries, ["US"]);
  const refused = checkedDefaults({ ...READY, countries: "ZZ" });
  assert.equal(refused.ok, false);
});

test("a live paid publish is refused with 'no targeting country' before any request when the run names none", () => {
  const route = liveRouteFor({ accessToken: "fixture-token", countries: [], pageId: "page-1", link: "https://example.com/a" });
  assert.equal("refused" in route, true);
  if ("refused" in route) assert.equal(route.refused, NO_TARGETING_COUNTRY_REASON);
  assert.match(NO_TARGETING_COUNTRY_REASON, /no targeting country/);
});

test("a live paid publish with no stored Meta token is not connected, and with no Page or link it is refused before any request", () => {
  assert.equal("notConnected" in liveRouteFor({ accessToken: null, countries: ["US"], pageId: "", link: "" }), true);

  const noPage = liveRouteFor({ accessToken: "fixture-token", countries: ["US"], pageId: "", link: "" });
  assert.equal("refused" in noPage, true);
  if ("refused" in noPage) assert.equal(noPage.refused, NO_PAGE_OR_LINK_REASON);

  const ready = liveRouteFor({ accessToken: "fixture-token", countries: ["US"], pageId: "page-1", link: "https://example.com/a" });
  assert.equal("engine" in ready, true);
  if ("engine" in ready) assert.equal(ready.engine.id, "meta");
});

test("the fixture paid publisher still creates the four paused stages, with or without countries", async () => {
  const engine = publishEngineById("test");
  for (const countries of [[], ["US"]]) {
    const result = await engine.publishPaused({ name: "Meridian Factory fixture", dailyBudgetCents: 300, countries, pageId: "", link: "", message: "" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.stages.map((stage) => stage.objectType), ["campaign", "ad_set", "creative", "ad"]);
    assert.ok(result.stages.every((stage) => stage.status === "stored" && stage.externalId));
  }
});

test("the countries of a paid run reach the ad set's targeting in the Meta request body", async () => {
  const sent: TransportRequest[] = [];
  let issued = 0;
  const transport: Transport = async (request) => {
    sent.push(request);
    issued += 1;
    return { status: 200, body: JSON.stringify({ id: `fixture_${issued}` }), headers: {} };
  };
  const result = await metaPublishEngine().publishPaused({
    name: "Meridian Factory targeting",
    dailyBudgetCents: 500,
    countries: ["US", "CA"],
    pageId: "page-1",
    link: "https://example.com/landing",
    message: "Hello",
    accessToken: "fixture-token",
    env: { META_AD_ACCOUNT_ID: "act_1234" },
    transport,
  });
  assert.equal(result.ok, true, result.error);
  const adSet = sent.find((request) => request.url.endsWith("/adsets"));
  assert.ok(adSet, "the ad set is created");
  const body = JSON.parse(String(adSet.body)) as { targeting: { geo_locations: { countries: string[] } }; status: string };
  assert.deepEqual(body.targeting.geo_locations.countries, ["US", "CA"]);
  assert.equal(body.status, "PAUSED");
});
