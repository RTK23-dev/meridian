// Checks the environment a deployment is about to start with, before it starts. It prints setting NAMES and a verdict, never a value, and it
// calls nothing: no database, no provider. Usage: npm run check:deployment   (exit 1 when a required setting is missing or unsafe).

/** @typedef {{ level: "error" | "warn" | "ok", name: string, message: string }} Finding */

const isSet = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Finding[]}
 */
export function checkDeployment(env) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (level, name, message) => findings.push({ level, name, message });
  const production = env.NODE_ENV === "production";

  if (!production) add("warn", "NODE_ENV", "Not production. A deployment runs with NODE_ENV=production; the testing runtime and a missing database are only allowed outside it.");
  else add("ok", "NODE_ENV", "production");

  if (!isSet(env, "DATABASE_URL")) add(production ? "error" : "warn", "DATABASE_URL", "Not set. A deployment needs a PostgreSQL 16 database with pgvector; production refuses to start without it.");
  else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) add("error", "DATABASE_URL", "Is not a postgres:// or postgresql:// URL.");
  else add("ok", "DATABASE_URL", "set");

  for (const name of ["BETTER_AUTH_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
    if (!isSet(env, name)) add(production ? "error" : "warn", name, "Not set. `npm run setup` generates it for a local run; set a long random value on a server. Without it sign-in or saved keys cannot work across restarts.");
    else if (env[name].length < 32) add("error", name, "Is shorter than 32 characters. Use a long random value.");
    else add("ok", name, "set");
  }

  if (!isSet(env, "BETTER_AUTH_URL")) add(production ? "error" : "warn", "BETTER_AUTH_URL", "Not set. It is the public origin used for sign-in cookies and invite links.");
  else if (production && !/^https:\/\//.test(env.BETTER_AUTH_URL)) add("error", "BETTER_AUTH_URL", "Is not https. A deployment is served over https.");
  else add("ok", "BETTER_AUTH_URL", "set");

  if (production && !isSet(env, "MERIDIAN_ALLOWED_OAUTH_ORIGINS")) add("warn", "MERIDIAN_ALLOWED_OAUTH_ORIGINS", "Not set. Required for OAuth redirects outside localhost (Google Drive and publishing connections).");

  if (env.MERIDIAN_TESTING_RUNTIME === "true") add(production ? "error" : "warn", "MERIDIAN_TESTING_RUNTIME", "Is true. The testing runtime enables placeholder providers and must never be set in production. (The app ignores it in production, but do not set it.)");
  if (env.VITE_AUTH_ENABLED === "false") add(production ? "error" : "warn", "VITE_AUTH_ENABLED", "Is false, which turns sign-in off. For local use only.");
  if (env.ALLOW_SYNTHETIC_TELEMETRY === "true") add(production ? "error" : "warn", "ALLOW_SYNTHETIC_TELEMETRY", "Is true. Synthetic telemetry is for tests only.");
  if (env.MERIDIAN_TRUST_PROXY_HEADERS === "true") add("warn", "MERIDIAN_TRUST_PROXY_HEADERS", "Is true. Only correct when every request comes through a trusted reverse proxy that overwrites these headers.");

  if (!isSet(env, "WEBHOOK_SECRET")) add("warn", "WEBHOOK_SECRET", "Not set. Webhooks are refused until it is.");
  const driveSet = isSet(env, "GOOGLE_SERVICE_ACCOUNT_KEY") || (isSet(env, "GOOGLE_CLIENT_ID") && isSet(env, "GOOGLE_CLIENT_SECRET"));
  if (!driveSet) add("warn", "GOOGLE_*", "Google Drive is not configured. Reference videos and other files cannot be uploaded to a session until it is. Meridian has no other file store for them.");
  else add("ok", "GOOGLE_*", "Drive credentials set (not checked against Google)");
  if (!isSet(env, "MEDIA_LINK_SECRET") || env.MEDIA_LINK_SECRET.length < 32) add("warn", "MEDIA_LINK_SECRET", "Not set, or shorter than 32 characters. Instagram and TikTok publishing stay not connected.");
  if (!(isSet(env, "EMAIL_API_URL") && isSet(env, "EMAIL_API_KEY"))) add("warn", "EMAIL_API_*", "Invitation email is not configured. Invitations are stored and not sent.");

  return findings;
}

/** @param {Finding[]} findings */
export function renderDeploymentCheck(findings) {
  const mark = { error: "ERROR", warn: "warn ", ok: "ok   " };
  const lines = findings.map((finding) => `${mark[finding.level]}  ${finding.name}: ${finding.message}`);
  const errors = findings.filter((finding) => finding.level === "error").length;
  const warns = findings.filter((finding) => finding.level === "warn").length;
  lines.push("", errors > 0 ? `NOT READY: ${errors} required setting${errors === 1 ? "" : "s"} missing or unsafe, ${warns} warning${warns === 1 ? "" : "s"}.` : `No blocking problem found, ${warns} warning${warns === 1 ? "" : "s"}. This checks settings only; it does not connect to the database or any provider.`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = checkDeployment(process.env);
  console.log(renderDeploymentCheck(findings));
  process.exit(findings.some((finding) => finding.level === "error") ? 1 : 0);
}
