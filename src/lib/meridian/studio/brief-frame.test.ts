// Editing the brand frame of a brief (prompt 14), on PGlite with every migration: a member's edit is saved and audited, a viewer is refused,
// a used brief keeps its frame, an invalid edit writes nothing, and a brief stored before the frame reads every field as not set.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The server module imports modules that use the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { updateBriefFrame } = await import("./brief-frame.server.ts");

const WS = "org_brief_frame";
const BRAND = "brand_brief_frame";
const MEMBER = "user_frame_member";
const VIEWER = "user_frame_viewer";

let db: TestDatabase;

async function insertBrief(id: string, status: string, frame: string): Promise<void> {
  await db.sql`
    insert into briefs (id, organization_id, brand_id, title, angle, hook, format, context_pack, workflow, why, status, created_by, frame)
    values (${id}, ${WS}, ${BRAND}, 'Brief', 'lather', 'Show the lather', 'short_ugc', '{}', '{}', '[]', ${status}, ${MEMBER}, ${frame})
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[MEMBER, "member"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  await insertBrief("brief_ready", "ready", "{}");
  await insertBrief("brief_used", "used", JSON.stringify({ platform: { value: "Reels", source: "person" } }));
});

after(async () => {
  await db.close();
});

test("a member's edit is saved as the person's value, and audited with the fields it named", async () => {
  const result = await updateBriefFrame(db.sql, MEMBER, {
    brandId: BRAND,
    briefId: "brief_ready",
    edit: { platform: "Instagram Reels", budgetUsd: 150, successCriteria: "Beats this brand's stored baseline" },
  });
  assert.deepEqual(result.frame.platform, { value: "Instagram Reels", source: "person" });
  const [stored] = await db.sql<{ frame: string }>`select frame from briefs where id = 'brief_ready'`;
  assert.equal(JSON.parse(stored?.frame ?? "{}").budgetUsd.value, 150, "the saved frame carries the budget");
  const audits = await db.sql<{ metadata: string }>`select metadata from audit_log where action = 'brief.frame_edited' and object_id = 'brief_ready'`;
  assert.equal(audits.length, 1, "one audit line for the edit");
  assert.match(String(audits[0]?.metadata ?? ""), /budgetUsd,platform,successCriteria/);
});

test("a viewer of the brand is refused, and nothing is changed", async () => {
  await assert.rejects(updateBriefFrame(db.sql, VIEWER, { brandId: BRAND, briefId: "brief_ready", edit: { platform: "Shorts" } }));
  const [stored] = await db.sql<{ frame: string }>`select frame from briefs where id = 'brief_ready'`;
  assert.doesNotMatch(stored?.frame ?? "", /Shorts/);
});

test("a used brief keeps its frame: the edit is refused and the stored frame is unchanged", async () => {
  await assert.rejects(updateBriefFrame(db.sql, MEMBER, { brandId: BRAND, briefId: "brief_used", edit: { platform: "Shorts" } }), /ready brief/);
  const [stored] = await db.sql<{ frame: string }>`select frame from briefs where id = 'brief_used'`;
  assert.equal(JSON.parse(stored?.frame ?? "{}").platform.value, "Reels");
});

test("an invalid edit is refused before anything is written", async () => {
  await assert.rejects(updateBriefFrame(db.sql, MEMBER, { brandId: BRAND, briefId: "brief_ready", edit: { budgetUsd: -10 } }), /positive/);
  const [stored] = await db.sql<{ frame: string }>`select frame from briefs where id = 'brief_ready'`;
  assert.equal(JSON.parse(stored?.frame ?? "{}").budgetUsd.value, 150, "the earlier saved budget is still there");
});
