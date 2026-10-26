import assert from "node:assert/strict";
import test from "node:test";
import { localAcceptanceBase } from "./local-base.mjs";

test("release acceptance defaults to the local server", () => {
  assert.equal(localAcceptanceBase(), "http://127.0.0.1:8080");
});

test("release acceptance permits explicit HTTP loopback hosts and ports", () => {
  assert.equal(localAcceptanceBase("http://localhost:9000/"), "http://localhost:9000");
  assert.equal(localAcceptanceBase("http://[::1]:8080"), "http://[::1]:8080");
});

for (const value of [
  "https://example.com",
  "http://example.com:8080",
  "https://localhost:8080",
  "http://localhost.evil.example:8080",
  "http://user:password@127.0.0.1:8080",
  "http://127.0.0.1:8080/path",
  "http://127.0.0.1:8080/?target=remote",
  "not a URL",
]) {
  test(`release acceptance rejects non-local or ambiguous base URL: ${value}`, () => {
    assert.throws(() => localAcceptanceBase(value), /requires an HTTP loopback URL/);
  });
}
