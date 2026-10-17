// The deploy migrator takes one Postgres advisory lock for the whole run, so overlapping builds cannot race on the same pending file.
// Running it needs a live Postgres, so these checks read its source: the lock is taken before the applied list is read, the key is one
// fixed integer, and the lock is released in the finally block, and only when it was taken.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./with-app-env.mjs";

const source = readFileSync(join(projectRoot(), "scripts/migrate.mjs"), "utf8");

test("the migration run takes one fixed advisory lock before it reads the applied list", () => {
  const lock = source.indexOf("SELECT pg_advisory_lock($1::bigint)");
  const applied = source.indexOf("SELECT name FROM _migrations");
  assert.ok(lock > 0, "the run takes pg_advisory_lock");
  assert.ok(applied > lock, "the applied list is read after the lock is taken");
  assert.match(source, /const MIGRATION_LOCK_KEY = \d+;/, "the key is one fixed integer");
});

test("the lock is released in the finally block, and only when it was taken", () => {
  const finallyAt = source.lastIndexOf("} finally {");
  const unlock = source.indexOf("SELECT pg_advisory_unlock($1::bigint)");
  assert.ok(finallyAt > 0, "the run has a finally block");
  assert.ok(unlock > finallyAt, "the unlock is in the finally block");
  assert.match(source.slice(finallyAt, unlock), /if \(locked\)/, "the unlock runs only when the lock was taken");
});

test("the PGlite skip path says it takes no lock, and why", () => {
  assert.match(source, /PGlite is\s+\/\/\s+single-process/, "the comment names the single-process reason");
});
