// The deploy migrator on a real PostgreSQL server. A fresh database reaches the head, a second run applies nothing, and a database one
// migration behind (the schema before the newest migration, holding its data) upgrades to the head with its data intact.
//
// Each database is one this test creates on the server named by MIGRATION_TEST_ADMIN_URL, and each is dropped afterwards. No database
// named by DATABASE_URL, or any other existing database, is touched. Without MIGRATION_TEST_ADMIN_URL the checks are skipped, as the
// other live checks are. CI sets it to its PostgreSQL service in the postgres job.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { projectRoot } from "./with-app-env.mjs";

const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL?.trim() ?? "";
const skip = adminUrl ? false : "MIGRATION_TEST_ADMIN_URL is not set, so the PostgreSQL migration checks were not run";
const root = projectRoot();
const migrationFiles = readdirSync(join(root, "migrations"));
const expected = pendingMigrations(migrationFiles, []).map(({ name }) => name);
const newest = expected.at(-1);

/**
 * What each newest migration created, so the upgrade check can put the database back one migration behind. When a newer migration is
 * added, add its undo here; until then the upgrade check is skipped rather than run against the wrong schema.
 */
const UNDO = {
  "0137_hold_releases.sql": ["drop table if exists generation_hold_releases"],
};

const created = [];

function databaseUrl(name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onAdmin(fn) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function freshDatabase() {
  const name = `meridian_migrate_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await onAdmin((client) => client.query(`create database "${name}"`));
  created.push(name);
  return databaseUrl(name);
}

function migrate(url) {
  const run = spawnSync(process.execPath, [join(root, "scripts/migrate.mjs")], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

async function onDatabase(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

after(async () => {
  for (const name of created) {
    await onAdmin((client) => client.query(`drop database if exists "${name}" with (force)`));
  }
});

test("a fresh database reaches the head: every migration is recorded once, and the newest table exists", { skip }, async () => {
  const url = await freshDatabase();
  const first = migrate(url);
  assert.equal(first.status, 0, first.output);
  const recorded = await onDatabase(url, (client) => client.query("select name from _migrations order by name"));
  assert.deepEqual(
    recorded.rows.map((row) => row.name),
    expected,
    "every migration file is recorded, in filename order",
  );
  assert.match(first.output, /done — \d+ migration\(s\) applied\./);
});

test("a second run on a database at the head applies nothing and reports it is up to date", { skip }, async () => {
  const url = await freshDatabase();
  assert.equal(migrate(url).status, 0);
  const again = migrate(url);
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /up to date\./);
});

test("a database one migration behind upgrades to the head, and its existing rows survive", { skip: skip || (UNDO[newest] ? false : `no undo is recorded for ${newest}`) }, async () => {
  const url = await freshDatabase();
  assert.equal(migrate(url).status, 0);
  await onDatabase(url, async (client) => {
    await client.query("insert into organizations (id, name, slug, created_by) values ('org_upgrade', 'Upgrade', 'org-upgrade', 'user_upgrade') on conflict do nothing");
    await client.query(
      `insert into model_runs (id, organization_id, correlation_id, operation, provider, model, prompt_id, prompt_version, status, estimate_usd)
       values ('run_upgrade', 'org_upgrade', 'corr', 'copy', 'openrouter', 'vendor/writer', 'p', '1', 'uncertain', 0.0003)
       on conflict do nothing`,
    );
    // Put the database back one migration: the newest migration's table is dropped and its record removed, and the data stays.
    for (const statement of UNDO[newest]) await client.query(statement);
    await client.query("delete from _migrations where name = $1", [newest]);
  });

  const upgraded = migrate(url);
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.match(upgraded.output, new RegExp(`applied ${newest.replace(/\./g, "\\.")}`), "only the newest migration is applied");
  await onDatabase(url, async (client) => {
    const table = await client.query("select to_regclass('generation_hold_releases') as name");
    assert.equal(table.rows[0].name, "generation_hold_releases");
    const kept = await client.query("select status, estimate_usd from model_runs where id = 'run_upgrade'");
    assert.equal(kept.rows[0]?.status, "uncertain", "the existing hold survives the upgrade, still uncertain");
  });
});
