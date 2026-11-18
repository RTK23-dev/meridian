// The secret settings the app reads: the key that seals stored tokens (and its previous value during a rotation), the key for the external embeddings service, the email
// service's key, the Cyclone key, and the webhook secret. Each accessor returns the raw value, exactly as the environment holds it.
// Nothing here trims, defaults or logs a value, so each caller keeps its own rule for a blank value. secret-settings.test.ts fails
// when any other app file reads one of these names from the environment, so every read of a secret is listed here.

/** The environment a read takes. Production passes the process environment; a test passes its own values. */
export type SecretEnv = Readonly<Record<string, string | undefined>>;

/** The key that seals stored tokens and session URIs (AES-256-GCM). */
export function tokenEncryptionKey(env: SecretEnv = process.env): string | undefined {
  return env.TOKEN_ENCRYPTION_KEY;
}

/**
 * The key TOKEN_ENCRYPTION_KEY replaced, set only while a rotation runs. Decryption tries it after the current key; nothing is
 * encrypted with it. `npm run keys:rotate` re-encrypts every stored value under the current key, after which it is removed.
 */
export function tokenEncryptionKeyPrevious(env: SecretEnv = process.env): string | undefined {
  return env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
}

/** The key for the external embeddings service. */
export function externalSemanticKey(env: SecretEnv = process.env): string | undefined {
  return env.EXTERNAL_SEMANTIC_KEY;
}

/** The key for the email delivery service. */
export function emailApiKey(env: SecretEnv = process.env): string | undefined {
  return env.EMAIL_API_KEY;
}

/** The key for the Cyclone scout service. */
export function cycloneApiKey(env: SecretEnv = process.env): string | undefined {
  return env.CYCLONE_API_KEY;
}

/** The secret that signs inbound webhooks. */
export function webhookSecret(env: SecretEnv = process.env): string | undefined {
  return env.WEBHOOK_SECRET;
}
