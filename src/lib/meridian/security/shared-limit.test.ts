import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { consumeWindow } from "./shared-limit.ts";

test("a shared window counts across callers and refuses the call past the limit", async () => {
  const db = new PGlite();
  await db.exec(`
    create table rate_limit_windows (
      bucket text not null,
      window_start timestamptz not null,
      hits integer not null,
      primary key (bucket, window_start)
    )
  `);
  const query = async (sql: string, params: unknown[]) => db.query<{ hits: number }>(sql, params);
  const now = Date.parse("2026-10-17T12:00:00Z");
  assert.equal(await consumeWindow(query, "auth:a", 2, 60_000, now), true);
  assert.equal(await consumeWindow(query, "auth:a", 2, 60_000, now + 1_000), true);
  assert.equal(await consumeWindow(query, "auth:a", 2, 60_000, now + 2_000), false);
  assert.equal(await consumeWindow(query, "auth:b", 2, 60_000, now + 2_000), true);
  assert.equal(await consumeWindow(query, "auth:a", 2, 60_000, now + 61_000), true);
});

test("a full bucket does not grant another full allowance at the next boundary", async () => {
  const db = new PGlite();
  await db.exec(`
    create table rate_limit_windows (
      bucket text not null,
      window_start timestamptz not null,
      hits integer not null,
      primary key (bucket, window_start)
    )
  `);
  const query = async (sql: string, params: unknown[]) => db.query<{ hits: number }>(sql, params);
  const start = 1_700_000_040_000;
  assert.equal(await consumeWindow(query, "auth:edge", 2, 60_000, start + 59_000), true);
  assert.equal(await consumeWindow(query, "auth:edge", 2, 60_000, start + 59_001), true);
  assert.equal(await consumeWindow(query, "auth:edge", 2, 60_000, start + 60_000), false);
});
