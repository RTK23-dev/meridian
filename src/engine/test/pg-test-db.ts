// Test helper, not a test. It gives every migration in migrations/ applied in name order (the order scripts/migrate.mjs and
// src/lib/db.ts use) on one of two engines:
// - PostgreSQL, when MERIDIAN_PG_TEST_URL names an admin connection that may create databases. Each test file gets a fresh
//   database, and the SQL runs through Meridian's own pool adapter (createPoolSql), the one the worker uses in production.
// - PGlite (PostgreSQL compiled to WebAssembly, in process) otherwise, so `npm test` needs no server.
// The owner runs the suite on a real server with MERIDIAN_PG_TEST_URL set (STATUS.md).

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { createPoolSql } from "../../lib/meridian/learning/pool-sql.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

type Rows = Record<string, unknown>[];

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

type TransactionalDb = Queryable & {
  transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
};

/** The migration files in apply order. Subdirectories (the opt-in auth schema) are not applied. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

function asParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    // Callers pass JSON as a string, the way the production SQL does. An object here is a bug, so it fails loudly.
    throw new Error("test SQL received an object parameter; JSON must be passed as a string");
  }
  return value;
}

/** A tagged-template Sql over PGlite, with transactions that run on one connection. */
function pgliteSql(handle: Queryable, begin?: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>): Sql {
  const run = async (text: string, params: unknown[]): Promise<Rows> => (await handle.query(text, params.map(asParam))).rows as Rows;
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Rows> => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1] ?? ""}`;
    }
    return run(text, values);
  };
  const handleSql = Object.assign(tagged, {
    query: (text: string, params: unknown[] = []) => run(text, params),
    ...(begin ? { begin } : {}),
  });
  return handleSql as unknown as Sql;
}

export type TestDatabase = {
  sql: Sql;
  /** Runs raw SQL that is not a tagged template (used for schema checks and re-applying a migration). */
  exec: (text: string) => Promise<void>;
  close: () => Promise<void>;
  /** "postgres" or "pglite": which engine ran the test. */
  engine: "postgres" | "pglite";
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.MERIDIAN_PG_TEST_URL?.trim();
  return adminUrl ? createPostgresDatabase(adminUrl) : createPgliteDatabase();
}

async function createPgliteDatabase(): Promise<TestDatabase> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const pgl = new PGlite({ extensions: { vector } }) as unknown as TransactionalDb & {
    waitReady: Promise<void>;
    exec: (text: string) => Promise<unknown>;
    close: () => Promise<void>;
  };
  await pgl.waitReady;
  for (const file of migrationFiles()) {
    await pgl.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const root = pgliteSql(pgl, <T>(fn: (tx: Sql) => Promise<T>) => pgl.transaction((tx) => fn(pgliteSql(tx))));
  return {
    sql: root,
    exec: async (text) => {
      await pgl.exec(text);
    },
    close: () => pgl.close(),
    engine: "pglite",
  };
}

async function createPostgresDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `engine_test_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  try {
    for (const file of migrationFiles()) {
      await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  } catch (error) {
    await pool.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
    throw error;
  }
  return {
    sql: createPoolSql(pool),
    exec: async (text) => {
      await pool.query(text);
    },
    close: async () => {
      await pool.end();
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    },
    engine: "postgres",
  };
}

/** Inserts an organization (and optionally a brand) that the engine rows can reference. */
export async function seedWorkspace(sql: Sql, organizationId: string, brandId?: string): Promise<void> {
  await sql`
    insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test')
    on conflict (id) do nothing
  `;
  if (brandId) {
    await sql`
      insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test')
      on conflict (id) do nothing
    `;
  }
}
