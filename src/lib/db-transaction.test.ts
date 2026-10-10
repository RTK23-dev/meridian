import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPoolSql } from "./db.ts";
import { getSql } from "./db.ts";
import { withTransaction, type Sql } from "./meridian/learning/store.ts";

// A throwaway table for these tests only. It is not part of the schema.
async function probe(sql: Sql) {
  await sql.query("create table if not exists db_txn_probe (id text primary key)");
  return async (id: string) => (await sql.query<{ id: string }>("select id from db_txn_probe where id = $1", [id])).length;
}

// Three behaviours, each checked against the real database: commit, rollback on throw, and nesting.
async function exerciseTransactions(sql: Sql) {
  const countOf = await probe(sql);

  // Commit: every write of a resolved block is visible afterwards.
  const committed = randomUUID();
  await withTransaction(sql, async (tx) => {
    await tx.query("insert into db_txn_probe (id) values ($1)", [committed]);
    await tx.query("insert into db_txn_probe (id) values ($1)", [`${committed}-b`]);
  });
  assert.equal(await countOf(committed), 1);
  assert.equal(await countOf(`${committed}-b`), 1);

  // Rollback: a thrown error undoes the earlier write of the block and is rethrown unchanged.
  const rolledBack = randomUUID();
  await assert.rejects(
    withTransaction(sql, async (tx) => {
      await tx.query("insert into db_txn_probe (id) values ($1)", [rolledBack]);
      throw new Error("the second step failed");
    }),
    /the second step failed/,
  );
  assert.equal(await countOf(rolledBack), 0, "the first write must not survive the failure");

  // Nesting: an inner begin joins the outer transaction, so an outer failure undoes the inner write too.
  const outerId = randomUUID();
  const innerId = randomUUID();
  await assert.rejects(
    withTransaction(sql, async (tx) => {
      await tx.query("insert into db_txn_probe (id) values ($1)", [outerId]);
      await withTransaction(tx, async (inner) => {
        await inner.query("insert into db_txn_probe (id) values ($1)", [innerId]);
      });
      throw new Error("outer failure");
    }),
    /outer failure/,
  );
  assert.equal(await countOf(outerId), 0);
  assert.equal(await countOf(innerId), 0, "the inner write joined the outer transaction and was rolled back with it");
}

test("withTransaction refuses to run without a real transaction, instead of simulating one", async () => {
  const noTransactions = Object.assign(async () => [], { query: async () => [] }) as unknown as Sql;
  await assert.rejects(withTransaction(noTransactions, async () => "never"), /cannot run a transaction/);
});

test("the database connection in this process: transactions commit, roll back, and nest", async () => {
  await exerciseTransactions(await getSql());
});

test("PostgreSQL pool: transactions commit, roll back, and nest on a pinned connection", async (t) => {
  const url = process.env.MERIDIAN_PG_TEST_URL?.trim();
  if (!url) {
    t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL pool transaction path was not run");
    return;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  try {
    await exerciseTransactions(createPoolSql(pool));
  } finally {
    await pool.end();
  }
});
