/**
 * A vault that really encrypts: saved rows hold ciphertext, and reads decrypt it through the production vault service.
 * Only the SQL shapes the provider credential and settings paths use are answered; everything else resolves to no rows.
 * Whitespace is collapsed, so a query written across several lines matches the same shape as one written on one line.
 */
export function fakeVaultSql() {
  const rows: Array<Record<string, any>> = [];
  const executed: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?").replace(/\s+/g, " ");
    executed.push({ query, values });
    if (query.includes("insert into credential_vault")) {
      rows.push({
        id: values[0],
        organization_id: values[1],
        credential_type: values[2],
        ciphertext: values[3],
        iv: values[4],
        tag: values[5],
        key_version: values[6],
        expires_at: values[7] ?? null,
        updated_at: new Date().toISOString(),
      });
      return Promise.resolve([]);
    }
    if (query.includes("delete from credential_vault")) {
      const index = rows.findIndex((r) => r.id === values[0] && r.organization_id === values[1]);
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve([]);
    }
    if (query.includes("select id, expires_at from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && r.credential_type === values[1]).slice(0, 1)
          .map((r) => ({ id: r.id, expires_at: r.expires_at })),
      );
    }
    if (query.includes("select id from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && r.credential_type === values[1]).slice(0, 1)
          .map((r) => ({ id: r.id })),
      );
    }
    if (query.includes("select id, credential_type, updated_at from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && String(r.credential_type).startsWith("provider_config:"))
          .map((r) => ({ id: r.id, credential_type: r.credential_type, updated_at: r.updated_at })),
      );
    }
    if (query.includes("select id, organization_id, ciphertext")) {
      return Promise.resolve(rows.filter((r) => r.id === values[0] && r.organization_id === values[1]));
    }
    return Promise.resolve([]);
  };
  return { sql, rows, executed };
}

/** Every deployment variable the JEV, Gemini and Hypit runtimes read. Tests clear these, then set only what they need. */
export const DEPLOYMENT_KEY_ENV = [
  "PERCEPTION_PROVIDER",
  "PERCEPTION_SHARED_DEFAULT",
  "JEV_SHARED_DEFAULT",
  "PRODUCTION_SHARED_DEFAULT",
  "MERIDIAN_GEMINI_API_KEY",
  "GOOGLE_AI_STUDIO_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MERIDIAN_GEMINI_OMNI_MODEL",
  "MERIDIAN_OMNI_MODEL",
  "MERIDIAN_IMAGE_MODEL",
  "GOOGLE_NANO_BANANA_MODEL",
  "TYPESAFE_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "OPENROUTER_JEV_API_KEY",
  "OPENROUTER_API_KEY",
  "MERIDIAN_JEV_PROVIDER_MODE",
  "JEV_PROVIDER_MODE",
  "JEV_MODE",
  "MERIDIAN_JEV_PREFERRED_PROVIDER",
  "JEV_PREFERRED_PROVIDER",
  "HYPIT_BASE_URL",
];

/** Runs `fn` with the given environment, clearing the deployment variables first and restoring everything after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = ["TOKEN_ENCRYPTION_KEY", ...DEPLOYMENT_KEY_ENV, ...Object.keys(vars)];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const next: Record<string, string | undefined> = {
    TOKEN_ENCRYPTION_KEY: "test-encryption-key-for-provider-settings",
    ...Object.fromEntries(DEPLOYMENT_KEY_ENV.map((k) => [k, undefined])),
    ...vars,
  };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}
