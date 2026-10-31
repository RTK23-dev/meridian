// Demo mode on PGlite with every migration. The demo batch is fixture rows: two videos the engine reports as delivered (no file exists) and one draft.
// It is marked demo everywhere, it is made once per brand, it reaches no provider, and the real reports leave it out.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { createDemoBatch } from "./demo-batch.ts";
import { readBrandRuns } from "./economics-store.ts";
import { readStartedHooks } from "./hook-history-store.ts";
import { recordDeliveryApproval } from "./service.ts";

const WS = "org_demo";
const BRAND = "brand_demo";
const ADMIN = "user_demo_admin";
const MEMBER = "user_demo_member";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[ADMIN, "admin"], [MEMBER, "member"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
});
after(async () => {
  await db.close();
});

test("the demo batch is two delivered fixture videos and a draft, all marked demo, made once per brand, for admins only", async () => {
  await assert.rejects(createDemoBatch(db.sql, MEMBER, { brandId: BRAND }));
  const batch = await createDemoBatch(db.sql, ADMIN, { brandId: BRAND });
  assert.equal(batch.demo, true);
  assert.match(batch.title, /^DEMO \(fixture\)/);
  assert.deepEqual(batch.items.map((item) => item.state), ["delivered", "delivered", "ready"]);
  assert.ok(batch.items.every((item) => item.demo && item.title.startsWith("DEMO (fixture)")));
  assert.deepEqual(batch.items.map((item) => item.approval), ["not_decided", "not_decided", null]);
  assert.ok(batch.items[0]?.manifestId?.startsWith("man_demo_"));
  assert.equal(batch.items[2]?.manifestId, null, "a draft has no manifest");
  const again = await createDemoBatch(db.sql, ADMIN, { brandId: BRAND });
  assert.equal(again.id, batch.id, "making it again returns the same demo batch");
  const [count] = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_batches where demo`;
  assert.equal(count?.n, "1");
});

test("the demo reaches no provider, and the real reports leave it out", async () => {
  const runs = await readBrandRuns(db.sql, WS, BRAND);
  assert.deepEqual(runs, [], "economics counts no demo request as a delivered video");
  const hooks = await readStartedHooks(db.sql, WS, BRAND);
  assert.deepEqual(hooks, [], "hook history counts no demo video");
  const [ledger] = await db.sql<{ n: string }>`select count(*)::text as n from engine_ledger`;
  assert.equal(ledger?.n, "0", "no money line was written");
  const [jobs] = await db.sql<{ n: string }>`select count(*)::text as n from engine_requests where format_id = 'fmt_demo' and status <> 'delivered'`;
  assert.equal(jobs?.n, "0", "no demo request is waiting for the engine");
});

test("a demo video can be approved and rejected like a delivered one, and the batch shows the decision", async () => {
  const batch = await createDemoBatch(db.sql, ADMIN, { brandId: BRAND });
  const [a, b] = batch.items;
  await recordDeliveryApproval(db.sql, ADMIN, { sessionId: a?.sessionId ?? "", decision: "approved", reason: "" });
  await recordDeliveryApproval(db.sql, ADMIN, { sessionId: b?.sessionId ?? "", decision: "rejected", reason: "The pacing is too slow for the format." });
  const after = await createDemoBatch(db.sql, ADMIN, { brandId: BRAND });
  assert.deepEqual(after.items.map((item) => item.approval), ["approved", "rejected", null]);
});
