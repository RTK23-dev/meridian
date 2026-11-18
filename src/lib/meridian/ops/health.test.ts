import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import { checkReadiness, migrationFilesIn, readinessResponse, withTimeout } from "./health.ts";

type Answers = {
  ping?: () => Promise<unknown[]>;
  migrations?: () => Promise<Array<{ name: string }>>;
  jobs?: () => Promise<Array<{ age_seconds: unknown }>>;
};

/** A fake Sql that answers by which query it is given. */
function fakeSql(answers: Answers): Sql {
  const run = (text: string): Promise<unknown[]> => {
    if (text.includes("select 1 as ok")) return answers.ping ? answers.ping() : Promise.resolve([{ ok: 1 }]);
    if (text.includes("_migrations")) return answers.migrations ? answers.migrations() : Promise.resolve([{ name: "0001_a.sql" }, { name: "0002_b.sql" }]);
    if (text.includes("from jobs")) return answers.jobs ? answers.jobs() : Promise.resolve([{ age_seconds: null }]);
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
  const sql = ((strings: TemplateStringsArray) => run(strings.join("?"))) as Sql;
  sql.query = ((text: string) => run(text)) as Sql["query"];
  return sql;
}

const FILES = () => ["0001_a.sql", "0002_b.sql"];
const never = () => new Promise<never>(() => {});

test("ready when the database answers, every migration is applied and no due job is old", async () => {
  const result = await checkReadiness({ sql: async () => fakeSql({}), migrationFiles: FILES });
  assert.deepEqual(result, { status: 200, body: { status: "ready", checks: { database: "ok", migrations: "ok", jobs: "ok" } } });
});

test("a due job younger than the threshold is fine; an older one is stalled", async () => {
  const young = await checkReadiness({
    sql: async () => fakeSql({ jobs: async () => [{ age_seconds: "59.5" }] }),
    migrationFiles: FILES,
    maxDueJobAgeMs: 60_000,
  });
  assert.equal(young.status, 200);
  const old = await checkReadiness({
    sql: async () => fakeSql({ jobs: async () => [{ age_seconds: 61 }] }),
    migrationFiles: FILES,
    maxDueJobAgeMs: 60_000,
  });
  assert.equal(old.status, 503);
  assert.equal(old.body.checks.jobs, "stalled");
});

test("a pending migration is not ready", async () => {
  const result = await checkReadiness({ sql: async () => fakeSql({}), migrationFiles: () => [...FILES(), "0003_c.sql"] });
  assert.equal(result.status, 503);
  assert.equal(result.body.checks.migrations, "pending");
});

test("an unreadable migrations folder or _migrations table is unknown, which is not ready", async () => {
  const noFolder = await checkReadiness({ sql: async () => fakeSql({}), migrationFiles: () => null });
  assert.equal(noFolder.body.checks.migrations, "unknown");
  assert.equal(noFolder.status, 503);
  const noTable = await checkReadiness({
    sql: async () => fakeSql({ migrations: () => Promise.reject(new Error('relation "_migrations" does not exist')) }),
    migrationFiles: FILES,
  });
  assert.equal(noTable.body.checks.migrations, "unknown");
});

test("a database that does not answer within the timeout fails fast, and the other checks stay unknown", async () => {
  const started = Date.now();
  const hung = await checkReadiness({ sql: async () => fakeSql({ ping: never }), migrationFiles: FILES, timeoutMs: 50 });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(hung.body, { status: "not_ready", checks: { database: "fail", migrations: "unknown", jobs: "unknown" } });
  const unreachable = await checkReadiness({ sql: never, migrationFiles: FILES, timeoutMs: 50 });
  assert.equal(unreachable.body.checks.database, "fail");
});

test("the body never carries an error message, a host or a count", async () => {
  const secretish = "connect ECONNREFUSED db.internal:5432 password=hunter2";
  const result = await checkReadiness({
    sql: async () => fakeSql({ ping: () => Promise.reject(new Error(secretish)) }),
    migrationFiles: FILES,
  });
  const text = JSON.stringify(result.body);
  assert.doesNotMatch(text, /internal|hunter2|ECONN|\d/);
});

test("the Response is uncached JSON with the right status", async () => {
  const response = await readinessResponse(() => Promise.reject(new Error("no database")));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).status, "not_ready");
});

test("migration files are read by the migrator's rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "ready-"));
  try {
    writeFileSync(join(dir, "0001_a.sql"), "");
    writeFileSync(join(dir, "notes.md"), "");
    assert.deepEqual(migrationFilesIn(dir), ["0001_a.sql"]);
    assert.equal(migrationFilesIn(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withTimeout passes values and errors through", async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  await assert.rejects(withTimeout(Promise.reject(new Error("x")), 50), /x/);
  await assert.rejects(withTimeout(never(), 10), /timed out/);
});
