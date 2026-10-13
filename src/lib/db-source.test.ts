import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { localDataDirFrom, resolveDbSource } from "./db-source.ts";

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

test("a real DATABASE_URL selects Neon in every environment", () => {
  assert.equal(
    resolveDbSource({ DATABASE_URL: "postgres://localhost/meridian", NODE_ENV: "production" }),
    "neon",
  );
  assert.equal(
    resolveDbSource({ DATABASE_URL: "postgres://localhost/meridian", NODE_ENV: "development" }),
    "neon",
  );
});

test("the embedded database is on disk only when MERIDIAN_LOCAL_DATA_DIR names a folder", () => {
  // Tests and CI never set the variable, so they keep the in-memory database. Only `npm run dev` sets it.
  assert.equal(localDataDirFrom({}), undefined);
  assert.equal(localDataDirFrom({ MERIDIAN_LOCAL_DATA_DIR: "" }), undefined);
  assert.equal(localDataDirFrom({ MERIDIAN_LOCAL_DATA_DIR: "   " }), undefined);
  assert.equal(localDataDirFrom({ MERIDIAN_LOCAL_DATA_DIR: " /work/meridian/.data/pglite " }), "/work/meridian/.data/pglite");
});

test("a data folder never reaches production: without DATABASE_URL, production still refuses to start", () => {
  // Assigned to a variable so the object-literal check does not reject the extra key. The folder is read by db.ts, not by the policy.
  const production = { NODE_ENV: "production", MERIDIAN_LOCAL_DATA_DIR: "/work/meridian/.data/pglite" };
  assert.throws(() => resolveDbSource(production), /Refusing to start without DATABASE_URL/);
});
