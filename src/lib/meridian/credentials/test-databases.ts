/**
 * The databases the credential tests run on. The embedded database is always used. When MERIDIAN_PG_TEST_URL names a
 * migrated PostgreSQL database, the same tests run on it too, through a real connection pool, so the transaction and the
 * tenant scoping are checked on both backends.
 */
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";

export type TestBackend = { name: string; sql: Sql; close: () => Promise<void> };

export async function openTestBackends(): Promise<TestBackend[]> {
  const backends: TestBackend[] = [{ name: "embedded", sql: await getSql(), close: async () => {} }];
  const url = process.env.MERIDIAN_PG_TEST_URL?.trim();
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    backends.push({ name: "postgres", sql: createPoolSql(pool), close: () => pool.end() });
  }
  return backends;
}

/** The provider key variables the resolver can read. Tests clear them, then set only what a test needs. */
export const PROVIDER_KEY_ENV = [
  "MERIDIAN_GEMINI_API_KEY",
  "GOOGLE_AI_STUDIO_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TYPESAFE_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "HIGGSFIELD_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_JEV_API_KEY",
  "OPENAI_API_KEY",
  "HYPIT_API_TOKEN",
  "HYPIT_API_KEY",
  "PERCEPTION_SHARED_DEFAULT",
  "JEV_SHARED_DEFAULT",
  "PRODUCTION_SHARED_DEFAULT",
  "OPENAI_SHARED_DEFAULT",
  "HYPIT_SHARED_DEFAULT",
  "OPENROUTER_SHARED_DEFAULT",
  "OPENROUTER_MODEL",
  "PERCEPTION_PROVIDER",
] as const;

/**
 * Runs `fn` with the given environment, clearing every provider key variable first, and restores the process environment
 * afterwards. Nothing set here leaks into another test.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = new Set<string>([...PROVIDER_KEY_ENV, "TOKEN_ENCRYPTION_KEY", ...Object.keys(vars)]);
  const original = new Map<string, string | undefined>();
  for (const key of keys) original.set(key, process.env[key]);
  for (const key of PROVIDER_KEY_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The vault row id for an organization's entry of one type, or null when there is none. */
export async function vaultRowId(sql: Sql, organizationId: string, credentialType: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from credential_vault where organization_id = ${organizationId} and credential_type = ${credentialType}
  `;
  return rows[0]?.id ?? null;
}
