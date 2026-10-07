/** Which database backend is active. */
export type DbSource = "neon" | "pglite";

export type DbSourceEnv = {
  DATABASE_URL?: string;
  NODE_ENV?: string;
  GROK_PROJECT_ID?: string;
};

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

/**
 * Production and published deploys refuse to boot on the in-memory database.
 * A missed DATABASE_URL used to silently open PGLite and drop every brand and
 * token on restart. Preview and local development keep the embedded fallback.
 */
export function resolveDbSource(env: DbSourceEnv): DbSource {
  const databaseUrl = trimmed(env.DATABASE_URL);
  const production = env.NODE_ENV === "production";
  const deployed = Boolean(trimmed(env.GROK_PROJECT_ID));
  if (!databaseUrl && (production || deployed)) {
    throw new Error(
      "Refusing to start without DATABASE_URL. Production and published deploys cannot use the in-memory database; set DATABASE_URL to a real Postgres instance.",
    );
  }
  return databaseUrl ? "neon" : "pglite";
}
