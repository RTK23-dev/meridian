import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isMigrationFile, migrationName, pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

const AUTH_MIGRATION = "0001_auth.sql";

/**
 * The auth-on copy of the Better Auth schema and its source, or null when the
 * app has not turned sign-in on (the shipped state).
 */
function authSchemaCopy(root) {
  const copy = join(root, "migrations", AUTH_MIGRATION);
  const source = join(root, "migrations/auth", AUTH_MIGRATION);
  if (!existsSync(copy) || !existsSync(source)) return null;
  return { copy: readFileSync(copy, "utf8"), source: readFileSync(source, "utf8") };
}

test("_migrations keys on basename, not path", () => {
  assert.equal(migrationName("/migrations/0002_todos.sql"), "0002_todos.sql");
  assert.equal(migrationName("migrations/auth/0001_auth.sql"), "0001_auth.sql");
  assert.equal(migrationName("0001_auth.sql"), "0001_auth.sql");
});

test("a file already applied from another directory does not re-apply", () => {
  // The auth-on path copies migrations/auth/0001_auth.sql into the globbed
  // directory; a database that already has it must not run it twice.
  assert.deepEqual(pendingMigrations(["/migrations/0001_auth.sql"], ["0001_auth.sql"]), []);
});

test("pending migrations are returned in name order", () => {
  assert.deepEqual(
    pendingMigrations(
      ["/migrations/0003_c.sql", "/migrations/0001_a.sql", "/migrations/0002_b.sql"],
      ["0001_a.sql"],
    ),
    [
      { name: "0002_b.sql", path: "/migrations/0002_b.sql" },
      { name: "0003_c.sql", path: "/migrations/0003_c.sql" },
    ],
  );
});

test("non-.sql entries are dropped (readdir also yields the auth/ directory)", () => {
  assert.equal(isMigrationFile("auth"), false);
  assert.deepEqual(pendingMigrations(["auth", "README.md"], []), []);
});

test("app migrations are pending on an empty database and the auth source still exists", () => {
  const migrationsDir = join(projectRoot(), "migrations");
  const pending = pendingMigrations(readdirSync(migrationsDir), []);
  assert.ok(pending.some((item) => item.name === "0010_activation.sql"));
  assert.ok(readdirSync(join(migrationsDir, "auth")).includes("0001_auth.sql"));
});

// The numbering gaps and duplicates the repo has today, pinned. Migrations apply in filename order, so a duplicate number is two files
// applied in alphabetical order, and a gap is a number with no file. Both are known: 0027 is used by two files, and 0083 to 0089 have no
// file. A new gap or duplicate fails the test below, so it is decided, not found later. To accept one, change the constants here and
// say why in docs/engine/PHASE_LOG.md.
const KNOWN_DUPLICATES = {
  "0027": ["0027_factory_pipeline_config.sql", "0027_unified_schema_reconciliation.sql"],
};
const KNOWN_GAPS = [83, 84, 85, 86, 87, 88, 89];

test("the migration numbers have exactly the known gaps and duplicates, and no others", () => {
  const names = readdirSync(join(projectRoot(), "migrations")).filter(isMigrationFile);
  for (const name of names) assert.match(name, /^\d{4}_.+\.sql$/, `${name} is numbered NNNN_name.sql`);
  const byNumber = new Map();
  for (const name of names) {
    const number = Number(name.slice(0, 4));
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  const duplicates = {};
  for (const [number, files] of byNumber) {
    if (files.length > 1) duplicates[String(number).padStart(4, "0")] = files.sort();
  }
  const top = Math.max(...byNumber.keys());
  // 0001 is the opt-in auth schema. It is copied up from migrations/auth/ only when sign-in is on, so its absence is not a gap.
  const gaps = [];
  for (let number = 2; number <= top; number += 1) if (!byNumber.has(number)) gaps.push(number);
  assert.deepEqual(gaps, KNOWN_GAPS, "a number is missing from migrations/ that is not a known gap");
  assert.deepEqual(duplicates, KNOWN_DUPLICATES, "a migration number is used by more than one file that is not a known duplicate");
});

test("this workspace's auth schema copy is byte-identical to its source", () => {
  // An edited copy diverges silently: basename keying skips it on a database
  // that already ran the original, and applies it on a fresh PGLite preview.
  const pair = authSchemaCopy(projectRoot());
  if (pair === null) return; // sign-in off — nothing has been copied up
  assert.equal(
    pair.copy,
    pair.source,
    "migrations/0001_auth.sql has been edited — it must stay a verbatim copy of migrations/auth/0001_auth.sql",
  );
});

test("the copy check reads both files and catches an edit", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-schema-"));
  mkdirSync(join(root, "migrations/auth"), { recursive: true });
  writeFileSync(join(root, "migrations/auth", AUTH_MIGRATION), "create table t ();\n");
  assert.equal(authSchemaCopy(root), null);

  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t ();\n");
  const same = authSchemaCopy(root);
  assert.equal(same.copy, same.source);

  writeFileSync(join(root, "migrations", AUTH_MIGRATION), "create table t (x int);\n");
  const drifted = authSchemaCopy(root);
  assert.notEqual(drifted.copy, drifted.source);
});
