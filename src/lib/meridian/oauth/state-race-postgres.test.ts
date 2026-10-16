import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Sql } from "../learning/store.ts";
import { claimOauthState } from "./state.ts";

/**
 * The OAuth single-use claim under real concurrency: many callbacks, each on its own pooled connection, present the
 * same state at once. PGlite serializes its queries on one connection, so it cannot show this race. This test runs only
 * when MERIDIAN_PG_TEST_URL names an admin connection that may create databases:
 *
 *   MERIDIAN_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
 */
const adminUrl = process.env.MERIDIAN_PG_TEST_URL?.trim();
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

function urlWithDatabase(base: string, database: string) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function sqlOverPool(pool: pg.Pool): Sql {
  const query = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[];
  const tagged = (async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    return query<T>(text, values);
  }) as unknown as Sql;
  tagged.query = query as Sql["query"];
  return tagged;
}

async function withFreshMigratedDatabase<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const database = `meridian_oauth_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  await admin.end();

  const migrator = new pg.Client({ connectionString: urlWithDatabase(adminUrl!, database) });
  await migrator.connect();
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) await migrator.query(await readFile(join(migrationsDir, file), "utf8"));
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: urlWithDatabase(adminUrl!, database), max: 12 });
  pool.on("error", () => {});
  try {
    return await run(sqlOverPool(pool));
  } finally {
    await pool.end();
    const drop = new pg.Client({ connectionString: adminUrl });
    await drop.connect();
    await drop.query(`drop database "${database}" with (force)`);
    await drop.end();
  }
}

const origin = "https://meridian.example";

test("concurrent callbacks presenting one state: exactly one claims it", { skip: adminUrl ? false : "MERIDIAN_PG_TEST_URL is not set" }, async () => {
  await withFreshMigratedDatabase(async (sql) => {
    const orgId = `org-race-${randomUUID().slice(0, 8)}`;
    await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, ${orgId}, ${orgId}, 'creator')`;
    const userId = `user-race-${randomUUID().slice(0, 8)}`;
    await sql`
      insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@example.test`}, true)
    `;
    await sql`
      insert into oauth_states (state_hash, organization_id, provider, expires_at, redirect_origin, user_id)
      values ('race-hash', ${orgId}, 'meta', now() + interval '10 minutes', ${origin}, ${userId})
    `;
    const attempts = await Promise.all(
      Array.from({ length: 24 }, () => claimOauthState(sql, { stateHash: "race-hash", userId, provider: "meta", origin })),
    );
    const winners = attempts.filter((claim) => claim !== null);
    assert.equal(winners.length, 1, "one callback wins; the rest see the state as used");
    assert.equal(winners[0]?.organizationId, orgId);
    const rows = await sql<{ used_at: string | null }>`select used_at from oauth_states where state_hash = 'race-hash'`;
    assert.ok(rows[0]?.used_at, "the state is recorded as used");
  });
});
