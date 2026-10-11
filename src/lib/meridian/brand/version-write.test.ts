import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { AUTOSAVE_NOTE, SAVE_NOTE, brainVersionAction, writeBrainVersion } from "./version-write.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

test("the rule replaces only the same editor's newest autosave, and appends for everything else", () => {
  const sameEditorAutosave = { note: AUTOSAVE_NOTE, createdBy: "ana" };
  assert.equal(brainVersionAction({ autosave: true, editorId: "ana", newest: sameEditorAutosave }), "replace");
  assert.equal(brainVersionAction({ autosave: true, editorId: "ana", newest: null }), "append", "the first autosave has nothing to replace");
  assert.equal(brainVersionAction({ autosave: true, editorId: "ben", newest: sameEditorAutosave }), "append", "another editor's autosave is kept");
  assert.equal(brainVersionAction({ autosave: true, editorId: "ana", newest: { note: SAVE_NOTE, createdBy: "ana" } }), "append", "a Save is never overwritten by an autosave");
  assert.equal(brainVersionAction({ autosave: false, editorId: "ana", newest: sameEditorAutosave }), "append", "a Save always appends");
});

/**
 * Autosaves while typing replace one row, so the history does not grow with the typing. A Save adds a row, and an autosave
 * after it starts a new autosave row rather than changing the Save.
 */
async function autosavesDoNotGrowHistory(sql: Sql) {
  const tenant = await studioTenant(sql, `versions-${Math.random().toString(36).slice(2, 8)}`);
  const count = async () => Number((await sql<{ n: number }>`select count(*)::int as n from brand_brain_versions where brand_id = ${tenant.brandId}`)[0]?.n);
  let version = 0;
  const next = () => {
    version += 1;
    return version;
  };

  for (let keystroke = 0; keystroke < 10; keystroke += 1) {
    const action = await writeBrainVersion(sql, { brandId: tenant.brandId, editorId: tenant.userId, autosave: true, version: next(), snapshot: `{"n":${keystroke}}` });
    assert.equal(action, keystroke === 0 ? "append" : "replace");
  }
  assert.equal(await count(), 1, "ten autosaves from one editor leave one version row");
  const [latest] = await sql<{ version: number; snapshot: string; note: string }>`
    select version, snapshot, note from brand_brain_versions where brand_id = ${tenant.brandId} order by version desc limit 1
  `;
  assert.equal(latest?.snapshot, '{"n":9}', "the one row holds the latest autosave");
  assert.equal(latest?.version, 10, "the row takes the newest version number");
  assert.equal(latest?.note, AUTOSAVE_NOTE);

  await writeBrainVersion(sql, { brandId: tenant.brandId, editorId: tenant.userId, autosave: false, version: next(), snapshot: '{"saved":true}' });
  assert.equal(await count(), 2, "a Save appends a version");

  await writeBrainVersion(sql, { brandId: tenant.brandId, editorId: tenant.userId, autosave: true, version: next(), snapshot: '{"n":"after save"}' });
  assert.equal(await count(), 3, "an autosave after a Save starts a new autosave row, and the Save is kept");
  await writeBrainVersion(sql, { brandId: tenant.brandId, editorId: tenant.userId, autosave: true, version: next(), snapshot: '{"n":"again"}' });
  assert.equal(await count(), 3, "further autosaves replace that row");

  const other = await studioTenant(sql, `versions-other-${Math.random().toString(36).slice(2, 8)}`);
  await writeBrainVersion(sql, { brandId: tenant.brandId, editorId: other.userId, autosave: true, version: next(), snapshot: '{"n":"other editor"}' });
  assert.equal(await count(), 4, "another editor's autosave is appended, not written over");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`brain autosaves do not grow the version history on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL version check was not run");
      return;
    }
    if (target === "PGlite") {
      await autosavesDoNotGrowHistory(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await autosavesDoNotGrowHistory(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
