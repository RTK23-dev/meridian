import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { isWorkspaceAdmin } from "./admin-check.ts";

const ORG = "org_oauth_admin";
const OTHER = "org_oauth_other";
let db: TestDatabase;

async function member(userId: string, organizationId: string, role: string): Promise<void> {
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@example.test`}, true) on conflict (id) do nothing`;
  await db.sql`
    insert into memberships (id, organization_id, user_id, role) values (${`mem_${organizationId}_${userId}`}, ${organizationId}, ${userId}, ${role})
    on conflict (organization_id, user_id) do update set role = excluded.role
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, "brand_oauth_a");
  await seedWorkspace(db.sql, OTHER, "brand_oauth_b");
  await member("u_admin", ORG, "admin");
  await member("u_owner", ORG, "owner");
  await member("u_member", ORG, "member");
  await member("u_viewer", ORG, "viewer");
  await member("u_elsewhere", OTHER, "admin");
});
after(async () => { await db.close(); });

test("an admin or owner of the workspace may finish a connection", async () => {
  assert.equal(await isWorkspaceAdmin(db.sql, "u_admin", ORG), true);
  assert.equal(await isWorkspaceAdmin(db.sql, "u_owner", ORG), true);
});

test("a member, a viewer, a person of another workspace and a stranger may not", async () => {
  assert.equal(await isWorkspaceAdmin(db.sql, "u_member", ORG), false);
  assert.equal(await isWorkspaceAdmin(db.sql, "u_viewer", ORG), false);
  assert.equal(await isWorkspaceAdmin(db.sql, "u_elsewhere", ORG), false);
  assert.equal(await isWorkspaceAdmin(db.sql, "u_nobody", ORG), false);
});

test("a person demoted after starting the connection may not finish it", async () => {
  await member("u_demoted", ORG, "admin");
  assert.equal(await isWorkspaceAdmin(db.sql, "u_demoted", ORG), true);
  await member("u_demoted", ORG, "member");
  assert.equal(await isWorkspaceAdmin(db.sql, "u_demoted", ORG), false);
});
