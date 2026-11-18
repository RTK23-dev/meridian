import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  decryptionKeys,
  decryptPayload,
  decryptPayloadWithKeys,
  encryptPayload,
  openCompactWithKeys,
  sealCompact,
} from "./crypto.ts";
import { openSecret, sealSecret } from "../oauth/flow.server.ts";
import { openSessionUri, sealSessionUri } from "../storage/session-seal.ts";
import { rotationKeys, RotationRefused } from "./rotate.ts";

const OLD = "old-key-for-rotation-tests-0000000001";
const NEW = "new-key-for-rotation-tests-0000000002";
const OTHER = "unrelated-key-for-rotation-tests-00003";

const saved = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = saved;
});

describe("the order decryption tries keys in", () => {
  it("is the current key, then the previous key as set, then trimmed", () => {
    assert.deepEqual(decryptionKeys(NEW, OLD), [NEW, OLD]);
    assert.deepEqual(decryptionKeys(NEW, ` ${OLD} `), [NEW, ` ${OLD} `, OLD]);
  });
  it("leaves out a blank or repeated previous key", () => {
    assert.deepEqual(decryptionKeys(NEW, undefined), [NEW]);
    assert.deepEqual(decryptionKeys(NEW, "  "), [NEW]);
    assert.deepEqual(decryptionKeys(NEW, NEW), [NEW]);
  });
  it("never tries the previous key alone when the current key is blank", () => {
    assert.deepEqual(decryptionKeys("", OLD), [""]);
    assert.throws(() => decryptPayloadWithKeys(encryptPayload("x", OLD), decryptionKeys("", OLD)), /missing or empty/);
  });
  it("reports which position opened a value, the current key first", () => {
    const both = [NEW, OLD];
    assert.equal(decryptPayloadWithKeys(encryptPayload("a", NEW), both).keyIndex, 0);
    assert.equal(decryptPayloadWithKeys(encryptPayload("a", OLD), both).keyIndex, 1);
    assert.equal(openCompactWithKeys(sealCompact("a", NEW), both).keyIndex, 0);
    assert.equal(openCompactWithKeys(sealCompact("a", OLD), both).keyIndex, 1);
  });
  it("throws the current key's error when no key opens a value, naming no key", () => {
    assert.throws(
      () => decryptPayloadWithKeys(encryptPayload("secret-plaintext", OTHER), [NEW, OLD]),
      (error: Error) => !error.message.includes("secret-plaintext") && !error.message.includes(NEW) && !error.message.includes(OLD),
    );
  });
});

describe("decrypting with TOKEN_ENCRYPTION_KEY_PREVIOUS", () => {
  it("opens envelopes, compact seals and session URIs sealed with the previous key", () => {
    const envelope = encryptPayload("vault-plaintext", OLD);
    const compact = sealSecret("oauth-token", OLD) as string;
    const session = sealSessionUri("https://upload.example/session", OLD);
    assert.throws(() => decryptPayload(envelope, NEW));
    assert.throws(() => openSecret(compact, NEW));
    assert.throws(() => openSessionUri(session, NEW));

    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD;
    assert.equal(decryptPayload(envelope, NEW), "vault-plaintext");
    assert.equal(openSecret(compact, NEW), "oauth-token");
    assert.equal(openSessionUri(session, NEW), "https://upload.example/session");
  });
  it("still fails for a value sealed with neither key", () => {
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD;
    assert.throws(() => decryptPayload(encryptPayload("x", OTHER), NEW));
    assert.throws(() => openSecret(sealSecret("x", OTHER) as string, NEW));
  });
  it("encrypts with the current key only", () => {
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = OLD;
    const envelope = encryptPayload("p", NEW);
    const compact = sealSecret("p", NEW) as string;
    assert.equal(decryptPayloadWithKeys(envelope, [NEW]).plaintext, "p");
    assert.throws(() => decryptPayloadWithKeys(envelope, [OLD]));
    assert.equal(openCompactWithKeys(compact, [NEW]).plaintext, "p");
    assert.throws(() => openCompactWithKeys(compact, [OLD]));
  });
});

describe("the rotation's keys", () => {
  it("refuses when TOKEN_ENCRYPTION_KEY_PREVIOUS is unset or blank", () => {
    assert.throws(() => rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW }), RotationRefused);
    assert.throws(() => rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_KEY_PREVIOUS: " " }), RotationRefused);
  });
  it("refuses when the previous key equals the current key", () => {
    assert.throws(() => rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_KEY_PREVIOUS: NEW }), /the same/);
    assert.throws(() => rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_KEY_PREVIOUS: ` ${NEW}` }), /the same/);
  });
  it("refuses when TOKEN_ENCRYPTION_KEY is unset", () => {
    assert.throws(() => rotationKeys({ TOKEN_ENCRYPTION_KEY_PREVIOUS: OLD }), RotationRefused);
  });
  it("never puts a key in the refusal", () => {
    try {
      rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_KEY_PREVIOUS: NEW });
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(!(error as Error).message.includes(NEW));
    }
  });
  it("returns both keys when they differ", () => {
    assert.deepEqual(rotationKeys({ TOKEN_ENCRYPTION_KEY: NEW, TOKEN_ENCRYPTION_KEY_PREVIOUS: OLD }), { current: NEW, previous: OLD });
  });
});
