import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { AUTOSAVE_NOTE, SAVE_NOTE } from "./version-write.ts";
import { parseBrainChanges, parseBrainSection, readBrainProgress, recordBrainSection, saveBrainChanges } from "./brain-store.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

async function addMember(sql: Sql, organizationId: string, role: string): Promise<string> {
  const suffix = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-brain-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Brain Fixture', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${suffix}`}, ${organizationId}, ${userId}, ${role})`;
  return userId;
}

async function versionRows(sql: Sql, brandId: string) {
  return sql<{ version: number; note: string; snapshot: string }>`
    select version, note, snapshot from brand_brain_versions where brand_id = ${brandId} order by version asc
  `;
}

/**
 * One brand, opened, saved, left and opened again, with a viewer and a second editor. Every step reads the stored records
 * back, so the assertions hold for what the database kept, not for what the function returned.
 */
async function resumeAndSaveRules(sql: Sql) {
  const tenant = await studioTenant(sql, `brain-${Math.random().toString(36).slice(2, 8)}`);
  const { brandId, organizationId } = tenant;
  const editor = tenant.userId;
  const second = await addMember(sql, organizationId, "member");
  const viewer = await addMember(sql, organizationId, "viewer");

  assert.deepEqual(
    await readBrainProgress(sql, brandId),
    { section: null, touchedFields: [], updatedAt: null },
    "a brand the screen has never opened reads as not started",
  );

  // First visit: two fields saved from the audience section.
  const first = await saveBrainChanges(sql, {
    brandId,
    actorId: editor,
    changes: { targetCustomers: "Busy parents", positioning: "Plain soap" },
    autosave: false,
    section: "audience",
  });
  assert.equal(first.version, 1);
  assert.deepEqual([...first.touched].sort(), ["positioning", "targetCustomers"]);
  let progress = await readBrainProgress(sql, brandId);
  assert.equal(progress.section, "audience");
  assert.deepEqual([...progress.touchedFields].sort(), ["positioning", "targetCustomers"]);
  assert.ok(progress.updatedAt, "the time the person was last here is stored");

  // Opening another section records it, and writes nothing to the brain or its history.
  progress = await recordBrainSection(sql, { brandId, actorId: editor, section: "voice" });
  assert.equal(progress.section, "voice");
  assert.equal((await versionRows(sql, brandId)).length, 1, "opening a section adds no version");

  // A viewer and a stranger are refused on every write, and nothing changes.
  const outsider = `user-outside-${Math.random().toString(36).slice(2, 8)}`;
  await assert.rejects(
    saveBrainChanges(sql, { brandId, actorId: viewer, changes: { tone: "cold" }, autosave: false, section: "rules" }),
    /permission to do that/,
    "a viewer cannot save the brain",
  );
  await assert.rejects(
    recordBrainSection(sql, { brandId, actorId: viewer, section: "rules" }),
    /permission to do that/,
    "a viewer cannot record a section",
  );
  await assert.rejects(
    saveBrainChanges(sql, { brandId, actorId: outsider, changes: { tone: "cold" }, autosave: false, section: null }),
    /not available to you/,
    "someone outside the workspace cannot save the brain",
  );
  const afterRefusals = await readBrainProgress(sql, brandId);
  assert.equal(afterRefusals.section, "voice", "a refused visit does not move the stored section");
  assert.equal((await versionRows(sql, brandId)).length, 1, "a refused save adds no version");

  // A second editor changes tone. The first editor's form is older, and it changes positioning only.
  const secondSave = await saveBrainChanges(sql, { brandId, actorId: second, changes: { tone: "warm" }, autosave: false, section: null });
  assert.equal(secondSave.version, 2);
  assert.equal((await readBrainProgress(sql, brandId)).section, "voice", "a save without a section keeps the stored section");
  const firstSave = await saveBrainChanges(sql, {
    brandId,
    actorId: editor,
    changes: { positioning: "Plain soap, reworded" },
    autosave: false,
    section: "positioning",
  });
  assert.equal(firstSave.brain.tone, "warm", "a field the first editor did not send keeps the second editor's value");
  assert.deepEqual(firstSave.touched, ["positioning"]);
  const [stored] = await sql<{ tone: string; positioning: string }>`select tone, positioning from brand_brains where brand_id = ${brandId}`;
  assert.equal(stored?.tone, "warm", "the stored row keeps the field nobody edited in this save");
  assert.equal(stored?.positioning, "Plain soap, reworded");

  // Autosaves: one appended after a Save, then replaced by the same editor's next autosave. A manual Save appends.
  await saveBrainChanges(sql, { brandId, actorId: editor, changes: { positioning: "draft a" }, autosave: true, section: "positioning" });
  assert.equal((await versionRows(sql, brandId)).length, 4, "the first autosave after a Save is a new row");
  await saveBrainChanges(sql, { brandId, actorId: editor, changes: { positioning: "draft b" }, autosave: true, section: "positioning" });
  const afterSecondAutosave = await versionRows(sql, brandId);
  assert.equal(afterSecondAutosave.length, 4, "the next autosave replaces that row, so history does not grow with typing");
  assert.equal(afterSecondAutosave.at(-1)?.note, AUTOSAVE_NOTE);
  assert.equal(afterSecondAutosave.at(-1)?.version, 5);
  await saveBrainChanges(sql, { brandId, actorId: editor, changes: { positioning: "final" }, autosave: false, section: "positioning" });
  const rows = await versionRows(sql, brandId);
  assert.equal(rows.length, 5, "a manual Save appends a version");
  assert.equal(rows.at(-1)?.note, SAVE_NOTE);
  assert.equal(rows.at(-1)?.version, 6);

  // Every version row holds the full brain as it stood, not just the field that changed.
  const snapshot = JSON.parse(rows[0]?.snapshot ?? "{}") as { brain?: Record<string, string> };
  assert.equal(snapshot.brain?.targetCustomers, "Busy parents");
  assert.equal(snapshot.brain?.tone, "", "version 1 holds the brain as it stood then, before the second editor's tone change");

  // The resume record holds the section, the fields the person changed, and the time, and it is read the same way again.
  const reopened = await readBrainProgress(sql, brandId);
  assert.equal(reopened.section, "positioning");
  assert.deepEqual([...reopened.touchedFields].sort(), ["positioning", "targetCustomers", "tone"], "each changed field is listed once");
  assert.ok(reopened.updatedAt);
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the brain resumes where the person left off, and a save never replaces a field nobody sent, on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL brain check was not run");
      return;
    }
    if (target === "PGlite") {
      await resumeAndSaveRules(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await resumeAndSaveRules(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}

test("the save input refuses an unknown field, an overlong value and an unknown section", () => {
  assert.deepEqual(parseBrainChanges(undefined), {});
  assert.deepEqual(parseBrainChanges({ tone: "  dry  " }), { tone: "dry" });
  assert.throws(() => parseBrainChanges({ notAField: "x" }));
  assert.throws(() => parseBrainChanges({ tone: "x".repeat(4001) }), /4000 characters or fewer/);
  assert.throws(() => parseBrainChanges({ automationLevel: "reckless" }));
  assert.equal(parseBrainSection(undefined), null);
  assert.equal(parseBrainSection("audience"), "audience");
  assert.throws(() => parseBrainSection("everything"), /Unknown brain section/);
});
