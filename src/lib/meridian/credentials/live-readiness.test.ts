import assert from "node:assert/strict";
import test from "node:test";
import { readinessOf, renderReadiness } from "./live-readiness.ts";

const SECRET = "fixture-secret-value-not-a-real-key";

test("with no deployment variable set, every key reads not set and no shared default is opted in", () => {
  const rows = readinessOf({});
  const adLibrary = rows.find((row) => row.category === "meta_ad_library");
  assert.deepEqual(adLibrary?.keyVariables, ["META_AD_LIBRARY_TOKEN"]);
  assert.equal(adLibrary?.deploymentKeySet, false);
  assert.ok(rows.every((row) => row.sharedDefault.optedIn === false));
});

test("a blank key is not set, and a set key reads set", () => {
  const rows = readinessOf({ YOUTUBE_API_KEY: "   ", SERPAPI_API_KEY: SECRET });
  assert.equal(rows.find((row) => row.category === "youtube")?.deploymentKeySet, false);
  assert.equal(rows.find((row) => row.category === "search")?.deploymentKeySet, true);
});

test("a shared default is opted in only when it is set to the value the contract accepts", () => {
  const rows = readinessOf({ APIFY_SHARED_DEFAULT: "deployment", YOUTUBE_SHARED_DEFAULT: "yes" });
  assert.equal(rows.find((row) => row.category === "apify")?.sharedDefault.optedIn, true);
  assert.equal(rows.find((row) => row.category === "youtube")?.sharedDefault.optedIn, false);
});

test("a category with no deployment variable named in the contract reads null, not a guess", () => {
  const rows = readinessOf({});
  assert.equal(rows.find((row) => row.category === "jev")?.deploymentKeySet, null);
});

test("the OpenRouter key is read from its deployment-only variable", () => {
  const row = readinessOf({ OPENROUTER_API_KEY: SECRET }).find((item) => item.category === "openrouter");
  assert.deepEqual(row?.keyVariables, ["OPENROUTER_API_KEY"]);
  assert.equal(row?.deploymentKeySet, true);
});

test("the report names each variable and says set or not set, and never contains a value", () => {
  const text = renderReadiness(readinessOf({ META_AD_LIBRARY_TOKEN: SECRET, OPENROUTER_API_KEY: SECRET }));
  assert.equal(text.includes(SECRET), false, "no value is printed");
  assert.match(text, /meta_ad_library: META_AD_LIBRARY_TOKEN: set/);
  assert.match(text, /openrouter: OPENROUTER_API_KEY: set/);
});

test("each shared default is shown with the value its contract accepts, not a fixed word", () => {
  const text = renderReadiness(readinessOf({ PERCEPTION_SHARED_DEFAULT: "gemini" }));
  assert.match(text, /PERCEPTION_SHARED_DEFAULT=gemini: opted in/);
  assert.match(text, /APIFY_SHARED_DEFAULT=deployment: not opted in/);
});
