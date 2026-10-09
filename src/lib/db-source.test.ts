import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveDbSource } from "./db-source.ts";

test("an unset or unlisted NODE_ENV without DATABASE_URL refuses the in-memory database", () => {
  // The old policy opened PGLite whenever NODE_ENV was not "production", so a deploy that
  // forgot NODE_ENV dropped every brand and token on restart. The policy is now an allowlist.
  assert.throws(() => resolveDbSource({}), /in-memory database/);
  assert.throws(() => resolveDbSource({ DATABASE_URL: "  " }), /DATABASE_URL/);
  assert.throws(() => resolveDbSource({ NODE_ENV: "staging" }), /NODE_ENV is "staging"/);
  assert.throws(() => resolveDbSource({ NODE_ENV: "preview" }), /DATABASE_URL/);
  assert.throws(() => resolveDbSource({ NODE_ENV: "Production" }), /DATABASE_URL/);
});

/** Imports the real runtime database module in a clean child process, the way a deploy boots it. */
function importDatabaseModule(env: Record<string, string>) {
  const moduleUrl = new URL("./db.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`],
    { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 60_000 },
  );
}

test("production path: the database module refuses to load without DATABASE_URL or an explicit NODE_ENV", () => {
  const unset = importDatabaseModule({});
  assert.notEqual(unset.status, 0, "importing db.ts with no environment must fail");
  assert.match(unset.stderr, /Refusing to start without DATABASE_URL/);

  const deployed = importDatabaseModule({ NODE_ENV: "production" });
  assert.notEqual(deployed.status, 0);
  assert.match(deployed.stderr, /Refusing to start without DATABASE_URL/);
});

test("production path: the database module loads the embedded database only when NODE_ENV is development", () => {
  const dev = importDatabaseModule({ NODE_ENV: "development" });
  assert.equal(dev.status, 0, dev.stderr);
});

test("preview and local development keep the embedded database", () => {
  assert.equal(resolveDbSource({ NODE_ENV: "development" }), "pglite");
  assert.equal(resolveDbSource({ DATABASE_URL: "   ", NODE_ENV: "development" }), "pglite");
  assert.equal(resolveDbSource({ NODE_ENV: "test" }), "pglite");
});

test("production refuses to run without a real database", () => {
  assert.throws(
    () => resolveDbSource({ NODE_ENV: "production" }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => resolveDbSource({ NODE_ENV: "production", DATABASE_URL: "  " }),
    /in-memory database/,
  );
});

test("a published deploy also fails closed when DATABASE_URL is missing", () => {
  assert.throws(
    () => resolveDbSource({ GROK_PROJECT_ID: "proj_1" }),
    /published deploys/,
  );
});

test("a real DATABASE_URL selects Neon in every environment", () => {
  assert.equal(
    resolveDbSource({ DATABASE_URL: "postgres://localhost/meridian", NODE_ENV: "production" }),
    "neon",
  );
  assert.equal(
    resolveDbSource({ DATABASE_URL: "postgres://localhost/meridian", GROK_PROJECT_ID: "proj_1" }),
    "neon",
  );
});
