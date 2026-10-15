import assert from "node:assert/strict";
import { test } from "node:test";
import { engineMediaFunctionsBaseUrl, MEDIA_FUNCTIONS_BASE_URL_SETTING } from "./engine-media-functions.ts";

function settingOf(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [MEDIA_FUNCTIONS_BASE_URL_SETTING]: value };
}

test("the media functions base URL is read from its deployment setting: unset is null", () => {
  assert.equal(engineMediaFunctionsBaseUrl(settingOf(undefined)), null);
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("   ")), null);
  assert.equal(MEDIA_FUNCTIONS_BASE_URL_SETTING, "MEDIA_FUNCTIONS_BASE_URL");
});

test("a usable https origin is kept, without its trailing slash; a path is kept", () => {
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("https://fn.example.com/")), "https://fn.example.com");
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("https://host.example/ffmpeg/")), "https://host.example/ffmpeg");
});

test("a value that is not an https URL, or that carries a query, a fragment or credentials, is refused (null)", () => {
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("http://fn.example.com")), null);
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("not a url")), null);
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("https://fn.example.com/?key=1")), null);
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("https://fn.example.com/#frag")), null);
  assert.equal(engineMediaFunctionsBaseUrl(settingOf("https://user:pw@fn.example.com")), null);
});
