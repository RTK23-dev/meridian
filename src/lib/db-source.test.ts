import assert from "node:assert/strict";
import test from "node:test";
import { resolveDbSource } from "./db-source.ts";

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
