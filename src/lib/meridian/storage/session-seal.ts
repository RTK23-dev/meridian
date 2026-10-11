/**
 * Sealing for resumable upload session URIs. A session URI is a capability to write into one Google Drive upload, so Postgres
 * holds it sealed with TOKEN_ENCRYPTION_KEY, never as the raw URI. The seal is the vault's AES-256-GCM envelope. Only the
 * upload loop opens it, and the caller supplies the key. Nothing here logs a value.
 */
import { decryptPayload, encryptPayload } from "../vault/crypto.ts";

const SEALED_PREFIX = "sealed:v1:";

/** A sealed URI could not be sealed or opened. The message never includes the URI or the key. */
export class SessionSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSealError";
  }
}

/** An empty URI is stored as empty: it means no Drive session has been started yet. */
export function sealSessionUri(uri: string, masterKey: string): string {
  if (!uri) return "";
  if (!masterKey.trim()) {
    throw new SessionSealError("TOKEN_ENCRYPTION_KEY is not configured. The upload session was not stored, so no Drive upload was started.");
  }
  const envelope = encryptPayload(uri, masterKey.trim());
  return SEALED_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function openSessionUri(stored: string, masterKey: string): string {
  if (!stored) return "";
  if (!stored.startsWith(SEALED_PREFIX)) {
    throw new SessionSealError("The stored upload session is not sealed, so it cannot be read. Start the upload again.");
  }
  if (!masterKey.trim()) {
    throw new SessionSealError("TOKEN_ENCRYPTION_KEY is not configured, so the stored upload session cannot be opened.");
  }
  try {
    const envelope = JSON.parse(Buffer.from(stored.slice(SEALED_PREFIX.length), "base64url").toString("utf8")) as {
      ciphertext: string;
      iv: string;
      tag: string;
    };
    return decryptPayload(envelope, masterKey.trim());
  } catch {
    throw new SessionSealError("The stored upload session could not be opened. Its key may have changed.");
  }
}
