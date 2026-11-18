/**
 * The two AES-256-GCM formats sealed with TOKEN_ENCRYPTION_KEY. Both derive the AES key as SHA-256 of the key text and carry
 * no key id, so a wrong key is detected by the GCM authentication tag.
 * - The envelope: base64 ciphertext, iv and tag kept apart (credential_vault, and inside sealed upload session URIs).
 * - The compact seal: base64 of iv (12 bytes) | tag (16 bytes) | ciphertext (provider_secrets.sealed_token, sealed_refresh).
 *
 * Rotation: encrypting always uses the key the caller passes (the current TOKEN_ENCRYPTION_KEY). Decrypting tries an explicit,
 * ordered list of keys: the current key first, then TOKEN_ENCRYPTION_KEY_PREVIOUS when it is set (see decryptionKeys). Nothing
 * here logs, and no error says which key was tried or worked.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { tokenEncryptionKeyPrevious } from "../credentials/secret-settings.ts";

export type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

type EnvelopeParts = { ciphertext: string; iv: string; tag: string };

/** A successful decryption and the position, in the list passed, of the key that opened it (0 is the current key). */
export type Opened = { plaintext: string; keyIndex: number };

/**
 * Derives a 32-byte AES key from the master secret using SHA-256.
 */
function deriveKey(secret: string): Buffer {
  if (!secret || !secret.trim()) {
    throw new Error("Encryption key is missing or empty.");
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * The keys a decryption tries, in order: the current key exactly as the caller passed it, then the previous key, as set and
 * trimmed (callers differ in whether they trim the current key, so both forms of the previous one are tried). A blank or
 * repeated key is left out. A blank current key is kept, so the decryption still fails as "missing" and the previous key is
 * never used on its own.
 */
export function decryptionKeys(current: string, previous: string | undefined = tokenEncryptionKeyPrevious()): string[] {
  const keys = [current];
  if (!current || !current.trim()) return keys;
  for (const candidate of [previous ?? "", (previous ?? "").trim()]) {
    if (candidate.trim() && !keys.includes(candidate)) keys.push(candidate);
  }
  return keys;
}

/** Runs `open` with each key in order and returns the first success. When every key fails, the current key's error is thrown. */
function firstThatOpens(keys: readonly string[], open: (key: string) => string): Opened {
  if (keys.length === 0) throw new Error("Encryption key is missing or empty.");
  let firstError: unknown = null;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    try {
      return { plaintext: open(keys[keyIndex] as string), keyIndex };
    } catch (error) {
      if (keyIndex === 0) firstError = error;
    }
  }
  throw firstError;
}

/**
 * Encrypts arbitrary text or serialized JSON using AES-256-GCM.
 * Generates a unique 12-byte IV for every encryption operation.
 */
export function encryptPayload(plaintext: string, secret: string, keyVersion = 1): EncryptedEnvelope {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion,
  };
}

function openEnvelope(envelope: EnvelopeParts, secret: string): string {
  const key = deriveKey(secret);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const encrypted = Buffer.from(envelope.ciphertext, "base64");

  if (iv.length !== 12) {
    throw new Error("Invalid IV length for AES-GCM.");
  }
  if (tag.length !== 16) {
    throw new Error("Invalid authentication tag length.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/** Opens an envelope with the first key in `keys` that authenticates it. Throws when none does. */
export function decryptPayloadWithKeys(envelope: EnvelopeParts, keys: readonly string[]): Opened {
  return firstThatOpens(keys, (key) => openEnvelope(envelope, key));
}

/**
 * Decrypts an AES-256-GCM envelope and verifies its authentication tag, with `secret` and then the previous key
 * (decryptionKeys). Throws if no key authenticates it (tampering or wrong key).
 */
export function decryptPayload(envelope: EnvelopeParts, secret: string): string {
  return decryptPayloadWithKeys(envelope, decryptionKeys(secret)).plaintext;
}

/** Seals text in the compact format: base64(iv | tag | ciphertext). */
export function sealCompact(plain: string, keyRaw: string): string {
  const key = deriveKey(keyRaw);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function openCompact(sealed: string, keyRaw: string): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 29) throw new Error("The stored token could not be read.");
  const key = deriveKey(keyRaw);
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const encrypted = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Opens a compact seal with the first key in `keys` that authenticates it. Throws when none does. */
export function openCompactWithKeys(sealed: string, keys: readonly string[]): Opened {
  return firstThatOpens(keys, (key) => openCompact(sealed, key));
}
