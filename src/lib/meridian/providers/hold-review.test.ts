// The administrator's review of uncertain holds on fixtures and the embedded database, and on Postgres when MERIDIAN_PG_TEST_URL names one.
// A member and an outsider are refused before anything is read or changed. An admin lists the uncertain holds and releases one, and the
// release is audited with the admin's id.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openTestBackends } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { setMonthlyBudget } from "../../../test-support/lib/meridian/testing/monthly-budget.ts";
import type { Sql } from "../learning/store.ts";
import { monthlyHeldUsd, reserveGenerationCall, settleGenerationCall, type HoldInput } from "./generation-ledger.ts";
import { listUncertainHoldsAs, releaseHoldAs } from "./hold-review.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

async function addUser(sql: Sql, organizationId: string, role: "admin" | "member" | null, label: string): Promise<string> {
  const userId = `user-hold-${label}-${Math.random().toString(36).slice(2, 10)}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Hold Fixture', ${`${userId}@fixture.example`}, true)`;
  if (role) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
  }
  return userId;
}

function holdFor(organizationId: string, brandId: string, operation: string): HoldInput {
  return {
    organizationId,
    brandId,
    correlationId: "corr-review",
    operation,
    promptId: "p",
    promptVersion: "1",
    inputRef: "r",
    provider: "openrouter",
    model: "vendor/writer",
    modelSource: "workspace",
  };
}

/** One uncertain hold in a new workspace, and the held id. */
async function uncertainHoldIn(sql: Sql, label: string): Promise<{ organizationId: string; brandId: string; memberId: string; holdId: string }> {
  const tenant = await studioTenant(sql, label);
  await setMonthlyBudget(sql, tenant.organizationId, 1);
  const held = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-review"), 0.0004);
  assert.equal(held.status, "held");
  if (held.status !== "held") throw new Error("the fixture hold was refused");
  await settleGenerationCall(sql, held.id, { status: "uncertain", error: "timed out", latencyMs: 25_000 });
  return { organizationId: tenant.organizationId, brandId: tenant.brandId, memberId: tenant.userId, holdId: held.id };
}

for (const { name, sql } of backends) {
  test(`[${name}] an admin lists the uncertain holds and releases one, and the release is audited with the admin's id`, async () => {
    const { organizationId, holdId } = await uncertainHoldIn(sql, `review-admin-${name}`);
    const admin = await addUser(sql, organizationId, "admin", `admin-${name}`);

    const listed = await listUncertainHoldsAs(sql, { userId: admin, organizationId });
    assert.deepEqual(listed.map((hold) => hold.id), [holdId]);
    assert.equal(listed[0]?.operation, "op-review");

    const released = await releaseHoldAs(sql, { userId: admin, organizationId, holdId, reason: "The provider account shows no charge." });
    assert.deepEqual(released, { status: "released", holdId });
    assert.equal(await monthlyHeldUsd(sql, organizationId), 0);
    const audit = await sql<{ actor_id: string }>`select actor_id from generation_hold_releases where model_run_id = ${holdId}`;
    assert.equal(audit[0]?.actor_id, admin, "the audit names the administrator who released the hold");
  });

  test(`[${name}] a member of the workspace is refused, and nothing is listed or released for them`, async () => {
    const { organizationId, memberId, holdId } = await uncertainHoldIn(sql, `review-member-${name}`);

    await assert.rejects(listUncertainHoldsAs(sql, { userId: memberId, organizationId }), /You do not have permission/);
    await assert.rejects(
      releaseHoldAs(sql, { userId: memberId, organizationId, holdId, reason: "The provider account shows no charge." }),
      /You do not have permission/,
    );
    const rows = await sql<{ status: string }>`select status from model_runs where id = ${holdId}`;
    assert.equal(rows[0]?.status, "uncertain", "a refused release changes nothing");
    const audit = await sql<{ n: string | number }>`select count(*) as n from generation_hold_releases where model_run_id = ${holdId}`;
    assert.equal(Number(audit[0]?.n), 0);
  });

  test(`[${name}] a user with no membership in the workspace is refused before anything is read`, async () => {
    const { organizationId, holdId } = await uncertainHoldIn(sql, `review-outsider-${name}`);
    const outsider = await addUser(sql, organizationId, null, `outsider-${name}`);

    await assert.rejects(listUncertainHoldsAs(sql, { userId: outsider, organizationId }), /not available to you/);
    await assert.rejects(
      releaseHoldAs(sql, { userId: outsider, organizationId, holdId, reason: "The provider account shows no charge." }),
      /not available to you/,
    );
  });
}
