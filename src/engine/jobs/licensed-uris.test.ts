import { test } from "node:test";
import assert from "node:assert/strict";
import { isLicensedProvider, licensedProvidersOf } from "./licensed-uris.ts";

test("the deployment's list names providers, trimmed and lower-cased, and an unset or empty list names none", () => {
  assert.deepEqual([...licensedProvidersOf(" Heygen , openrouter,,")].sort(), ["heygen", "openrouter"]);
  assert.equal(licensedProvidersOf(undefined).size, 0);
  assert.equal(licensedProvidersOf("").size, 0);
});

test("a reviewer's clip is licensed by the reviewer's attestation with no list; any other provider needs the list (Bible 12.3)", () => {
  const none = licensedProvidersOf(undefined);
  assert.equal(isLicensedProvider("reviewer", none), true);
  assert.equal(isLicensedProvider("openrouter", none), false, "unset list: generated output is not licensed");
  assert.equal(isLicensedProvider("pexels", none), false, "unset list: stock output is not licensed");
  assert.equal(isLicensedProvider("OpenRouter", licensedProvidersOf("openrouter")), true);
});
