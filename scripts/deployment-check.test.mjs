import assert from "node:assert/strict";
import test from "node:test";
import { checkDeployment, renderDeploymentCheck } from "./deployment-check.mjs";

const SECRET = "x".repeat(40);
const GOOD = { NODE_ENV: "production", DATABASE_URL: "postgres://u:pw@db.example/meridian", BETTER_AUTH_SECRET: SECRET, TOKEN_ENCRYPTION_KEY: `${SECRET}y`, BETTER_AUTH_URL: "https://app.example.com", MERIDIAN_ALLOWED_OAUTH_ORIGINS: "https://app.example.com" };
const levels = (env) => checkDeployment(env).filter((finding) => finding.level === "error").map((finding) => finding.name);

test("a complete production environment has no blocking problem, and still warns about Drive, email and webhooks", () => {
  assert.deepEqual(levels(GOOD), []);
  const warned = checkDeployment(GOOD).filter((finding) => finding.level === "warn").map((finding) => finding.name);
  assert.ok(warned.includes("GOOGLE_*") && warned.includes("WEBHOOK_SECRET") && warned.includes("EMAIL_API_*"));
});

test("production without a database, secrets or an https origin is not ready", () => {
  assert.deepEqual(levels({ NODE_ENV: "production" }).sort(), ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DATABASE_URL", "TOKEN_ENCRYPTION_KEY"]);
  assert.ok(levels({ ...GOOD, BETTER_AUTH_URL: "http://app.example.com" }).includes("BETTER_AUTH_URL"));
  assert.ok(levels({ ...GOOD, DATABASE_URL: "mysql://x" }).includes("DATABASE_URL"));
  assert.ok(levels({ ...GOOD, BETTER_AUTH_SECRET: "short" }).includes("BETTER_AUTH_SECRET"));
});

test("test-only switches are an error in production and only a warning elsewhere", () => {
  for (const name of ["MERIDIAN_TESTING_RUNTIME", "ALLOW_SYNTHETIC_TELEMETRY"]) {
    assert.ok(levels({ ...GOOD, [name]: "true" }).includes(name));
    assert.ok(!levels({ NODE_ENV: "development", [name]: "true" }).includes(name));
  }
  assert.ok(levels({ ...GOOD, VITE_AUTH_ENABLED: "false" }).includes("VITE_AUTH_ENABLED"));
});

test("Drive configured removes the Drive warning, and the report never prints a value", () => {
  const withDrive = { ...GOOD, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret-value-do-not-print" };
  assert.ok(!checkDeployment(withDrive).some((finding) => finding.level === "warn" && finding.name === "GOOGLE_*"));
  const report = renderDeploymentCheck(checkDeployment({ ...withDrive }));
  for (const value of [SECRET, "secret-value-do-not-print", "db.example", "pw"]) assert.ok(!report.includes(value), `the report must not contain ${value}`);
  assert.match(renderDeploymentCheck(checkDeployment({ NODE_ENV: "production" })), /NOT READY/);
});
