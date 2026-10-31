// The concurrency proposals of the video engine operations surface on PGlite (Video Engine Bible 10.4, 15.1, 15.2, 19 E6). The proposals are
// read from the workspace's provider attempts in the last hour and are never applied. A call counts toward a bucket only when the engine can
// tell which bucket it used. Today the route table names no model for OpenRouter (the model is chosen at run time), so no call can be
// matched, and every size is held. The rules for a 429 shrink are tested in src/engine/ops/concurrency.test.ts. Nothing here calls a live API.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BUCKET_CLASSES } from "../../../engine/ops/concurrency.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { alertsInput } from "./input.ts";
import { readWorkspaceConcurrency, WORKSPACE_REFUSAL } from "./service.ts";

const WS = "ws_conc_a";
const OTHER_WS = "ws_conc_b";
const MEMBER = "user_conc_member";
const OTHER_ADMIN = "user_conc_other_admin";
const STRANGER = "user_conc_stranger";
const PROVIDER = "openrouter:fixture/video-model";

async function seedUser(sql: Sql, userId: string, organizationId: string | null, role: string | null): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  if (organizationId !== null && role !== null) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
  }
}

describe("video engine operations: concurrency proposals", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS);
    await seedWorkspace(db.sql, OTHER_WS);
    await seedUser(db.sql, MEMBER, WS, "viewer");
    await seedUser(db.sql, OTHER_ADMIN, OTHER_WS, "admin");
    await seedUser(db.sql, STRANGER, null, null);
  });

  after(async () => {
    await db.close();
  });

  test("with no calls, every bucket is held at its current size, and it says why", async () => {
    const report = await readWorkspaceConcurrency(db.sql, MEMBER, alertsInput({ organizationId: WS }));
    assert.equal(report.thresholds, "ops-proposed@1");
    assert.equal(report.callsInWindow, 0);
    assert.equal(report.matchedCalls, 0);
    assert.deepEqual(
      report.proposals.map((proposal) => proposal.bucket),
      [...BUCKET_CLASSES],
    );
    for (const proposal of report.proposals) {
      assert.equal(proposal.basis, "insufficient_data");
      assert.equal(proposal.proposed, proposal.current, "a size is never moved on no data");
    }
  });

  test("calls that cannot be matched to a bucket are counted, and no size moves on them", async () => {
    const now = Date.now();
    for (let index = 0; index < 10; index += 1) {
      const limited = index < 2;
      await db.sql`
        insert into engine_provider_attempts (id, organization_id, provider_id, at_ms, outcome, latency_ms, error_kind)
        values (${`att_conc_${index}`}, ${WS}, ${PROVIDER}, ${now - 60_000}, ${limited ? "provider_failure" : "success"}, ${100}, ${limited ? "rate_limit" : null})
      `;
    }
    const report = await readWorkspaceConcurrency(db.sql, MEMBER, alertsInput({ organizationId: WS }), new Date(now));
    assert.equal(report.callsInWindow, 10, "the ten calls are in the window");
    assert.equal(report.matchedCalls, 0, "no call names a bucket the engine can match");
    for (const proposal of report.proposals) {
      assert.equal(proposal.basis, "insufficient_data");
      assert.equal(proposal.proposed, proposal.current);
    }
  });

  test("a stranger is refused, and another workspace sees only its own calls", async () => {
    await assert.rejects(readWorkspaceConcurrency(db.sql, STRANGER, alertsInput({ organizationId: WS })), { message: WORKSPACE_REFUSAL });
    const other = await readWorkspaceConcurrency(db.sql, OTHER_ADMIN, alertsInput({ organizationId: OTHER_WS }));
    assert.equal(other.callsInWindow, 0, "the other workspace has no calls, so none of this one's are counted");
  });
});
