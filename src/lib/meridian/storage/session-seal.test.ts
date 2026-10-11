import assert from "node:assert/strict";
import test from "node:test";
import { openSessionUri, SessionSealError, sealSessionUri } from "./session-seal.ts";

const KEY = "session-seal-test-key-with-sufficient-length-00";
const URI = "https://upload.example.test/session/abc-SECRET-capability-123";

test("a sealed session URI is not the raw URI, and opens back to it with the same key", () => {
  const sealed = sealSessionUri(URI, KEY);
  assert.notEqual(sealed, URI);
  assert.equal(sealed.includes("SECRET-capability"), false, "the capability does not appear in the sealed text");
  assert.equal(sealed.includes("upload.example.test"), false);
  assert.ok(sealed.startsWith("sealed:v1:"));
  assert.equal(openSessionUri(sealed, KEY), URI);
});

test("each seal uses a fresh IV, so two seals of one URI differ", () => {
  assert.notEqual(sealSessionUri(URI, KEY), sealSessionUri(URI, KEY));
});

test("an empty URI stays empty: it means no Drive session has started", () => {
  assert.equal(sealSessionUri("", KEY), "");
  assert.equal(openSessionUri("", KEY), "");
});

test("opening with a different key, or with tampered text, is refused", () => {
  const sealed = sealSessionUri(URI, KEY);
  assert.throws(() => openSessionUri(sealed, "a-different-key-that-is-also-long-enough-000"), SessionSealError);
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => openSessionUri(tampered, KEY), SessionSealError);
});

test("a raw URI that was never sealed is refused, not returned", () => {
  assert.throws(() => openSessionUri(URI, KEY), (err: unknown) => err instanceof SessionSealError && /not sealed/.test(err.message));
});

test("with no key, neither seal nor open runs, and the error names the setting but not a value", () => {
  assert.throws(() => sealSessionUri(URI, "   "), (err: unknown) => err instanceof SessionSealError && /TOKEN_ENCRYPTION_KEY/.test(err.message));
  const sealed = sealSessionUri(URI, KEY);
  assert.throws(() => openSessionUri(sealed, ""), (err: unknown) => err instanceof SessionSealError && !err.message.includes(URI));
});
