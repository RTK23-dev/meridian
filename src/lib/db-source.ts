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
 * NODE_ENV values that explicitly opt in to the embedded in-memory database. This is an
 * allowlist, not a production denylist: a deploy that forgets to set NODE_ENV, or sets a
 * value nobody listed, must bring DATABASE_URL instead of silently opening PGLite.
 */
const EMBEDDED_DATABASE_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "test"]);

/**
 * With DATABASE_URL set, Neon is used everywhere. Without it, the embedded PGLite database is
 * used only when NODE_ENV is explicitly declared as development or test. Every other case,
 * including production, preview, an unset NODE_ENV and published deploys, throws. Those
 * environments would otherwise drop every brand and token on restart.
 */
export function resolveDbSource(env: DbSourceEnv): DbSource {
  const databaseUrl = trimmed(env.DATABASE_URL);
  if (databaseUrl) return "neon";
  if (trimmed(env.GROK_PROJECT_ID)) {
    throw new Error(
      "Refusing to start without DATABASE_URL. Production and published deploys cannot use the in-memory database; set DATABASE_URL to a real Postgres instance.",
    );
  }
  const declared = trimmed(env.NODE_ENV);
  if (declared && EMBEDDED_DATABASE_ENVIRONMENTS.has(declared)) return "pglite";
  throw new Error(
    `Refusing to start without DATABASE_URL. The in-memory database is allowed only when NODE_ENV is explicitly "development" or "test"; NODE_ENV is ${declared ? `"${declared}"` : "unset"}. Set DATABASE_URL to a real Postgres instance.`,
  );
}
