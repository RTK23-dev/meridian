import assert from "node:assert/strict";
import test from "node:test";
import { previewAllowedHosts } from "./preview-hosts.mjs";

test("the public https origins of the deployment are allowed, by host name only", () => {
  assert.deepEqual(
    previewAllowedHosts({ APP_URL: "https://meridian.victor.ceo", BETTER_AUTH_URL: "https://meridian.victor.ceo/" }),
    ["meridian.victor.ceo"],
  );
  assert.deepEqual(
    previewAllowedHosts({ APP_URL: "https://meridian.victor.ceo", PUBLIC_APP_URL: "https://app.example.com:8443/x" }),
    ["meridian.victor.ceo", "app.example.com"],
  );
});

test("nothing set means nothing added, so Vite keeps its own defaults", () => {
  assert.deepEqual(previewAllowedHosts({}), []);
  assert.deepEqual(previewAllowedHosts({ APP_URL: "  ", PUBLIC_APP_URL: undefined }), []);
});

test("a value that is not a plain https origin adds nothing", () => {
  for (const bad of ["http://meridian.victor.ceo", "meridian.victor.ceo", "not a url", "https://*.victor.ceo", "ftp://x.example"]) {
    assert.deepEqual(previewAllowedHosts({ APP_URL: bad }), [], `${bad} must not be allowed`);
  }
});

test("a valid value beside an invalid one still counts, and duplicates are listed once", () => {
  assert.deepEqual(
    previewAllowedHosts({ APP_URL: "http://plain.example", BETTER_AUTH_URL: "https://meridian.victor.ceo", PUBLIC_APP_URL: "https://meridian.victor.ceo" }),
    ["meridian.victor.ceo"],
  );
});
