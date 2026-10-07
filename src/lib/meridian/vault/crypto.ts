import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

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

/**
 * Decrypts an AES-256-GCM envelope and verifies its authentication tag.
 * Returns null or throws an error if authentication fails (tampering/wrong key).
 */
export function decryptPayload(envelope: { ciphertext: string; iv: string; tag: string }, secret: string): string {
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
