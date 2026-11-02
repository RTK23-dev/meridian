// The batch report of the video engine operations surface on PGlite (Video Engine Bible 11.4, 20.3 item 6, 19 E6). A batch request is
// counted as batched only when the planner says so. For OpenRouter today the planner says no, so the report says the calls run as normal
// calls, with the planner's reason. The requests start through the engine's own start (src/engine/ops/test/chain.ts); nothing here calls
// a live API.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chainWorld, startChainRequest, type ChainWorld } from "../../../engine/ops/test/chain.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { stageMetricsInput } from "./input.ts";
import { readWorkspaceBatch, WORKSPACE_REFUSAL } from "./service.ts";

const WS = "ws_batch_a";
const OTHER_WS = "ws_batch_b";
const BRAND = "brand_batch_a";
const FORMAT = "fmt_batch_a";
const MEMBER = "user_batch_member";
const OTHER_ADMIN = "user_batch_other_admin";
const STRANGER = "user_batch_stranger";

async function seedUser(sql: Sql, userId: string, organizationId: string | null, role: string | null): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  if (organizationId !== null && role !== null) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
  }
}

describe("video engine operations: batch report", () => {
  let db: TestDatabase;
  let world: ChainWorld;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await seedWorkspace(db.sql, OTHER_WS);
    await seedUser(db.sql, MEMBER, WS, "viewer");
    await seedUser(db.sql, OTHER_ADMIN, OTHER_WS, "admin");
    await seedUser(db.sql, STRANGER, null, null);
    world = await chainWorld(db.sql, WS);
  });

  after(async () => {
    await db.close();
  });

  test("a workspace with no batch request reports none", async () => {
    const report = await readWorkspaceBatch(db.sql, MEMBER, stageMetricsInput({ organizationId: WS }));
    assert.deepEqual(report, { batchRequests: 0, asNormalCalls: 0, asBatch: 0, reason: null });
  });

  test("a request at normal priority is not a batch request", async () => {
    await startChainRequest(world, { slot: 1, brandId: BRAND, formatId: FORMAT, priority: "normal", variantCount: 0 });
    const report = await readWorkspaceBatch(db.sql, MEMBER, stageMetricsInput({ organizationId: WS }));
    assert.equal(report.batchRequests, 0);
    assert.equal(report.asBatch, 0);
  });

  test("a batch request runs as normal calls with the planner's reason, and is never counted as batched", async () => {
    await startChainRequest(world, { slot: 2, brandId: BRAND, formatId: FORMAT, priority: "batch", variantCount: 0 });
    const report = await readWorkspaceBatch(db.sql, MEMBER, stageMetricsInput({ organizationId: WS }));
    assert.equal(report.batchRequests, 1);
    assert.equal(report.asBatch, 0);
    assert.equal(report.asNormalCalls, 1);
    assert.match(report.reason ?? "", /OpenRouter batch support is unknown/);
    assert.match(report.reason ?? "", /run as normal calls/);
  });

  test("a stranger is refused, and another workspace reads only its own requests", async () => {
    await assert.rejects(readWorkspaceBatch(db.sql, STRANGER, stageMetricsInput({ organizationId: WS })), { message: WORKSPACE_REFUSAL });
    const other = await readWorkspaceBatch(db.sql, OTHER_ADMIN, stageMetricsInput({ organizationId: OTHER_WS }));
    assert.deepEqual(other, { batchRequests: 0, asNormalCalls: 0, asBatch: 0, reason: null });
  });
});
