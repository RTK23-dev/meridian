import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openTestBackends } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import type { Sql } from "../learning/store.ts";
import { monthlyVideoBudgetUsd, parseMonthlyVideoBudget, readWorkspaceVideoBudget, saveWorkspaceVideoBudget } from "./video-budget.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

test("parse: blank and null clear the budget; there is no default", () => {
  for (const input of [null, undefined, "", "   "]) assert.deepEqual(parseMonthlyVideoBudget(input), { ok: true, value: null });
});

test("parse: a number of 0 or more with at most two decimals is accepted as written", () => {
  const cases: Array<[unknown, number]> = [["0", 0], ["0.00", 0], ["250", 250], [" 1200.5 ", 1200.5], ["99.99", 99.99], [42, 42], [12.25, 12.25], ["9999999999.99", 9_999_999_999.99]];
  for (const [input, value] of cases) assert.deepEqual(parseMonthlyVideoBudget(input), { ok: true, value }, String(input));
});

test("parse: negative, more than two decimals, text, exponent, out of range and non-finite values are refused, never rounded", () => {
  for (const input of ["-1", "-0.01", "1.234", "abc", "1e3", "12,50", "$10", "10000000000", ".5", "5.", Number.NaN, Number.POSITIVE_INFINITY, -5, 0.125, true, {}, []]) {
    const parsed = parseMonthlyVideoBudget(input);
    assert.equal(parsed.ok, false, `${String(input)} is refused`);
  }
});

async function addMember(sql: Sql, organizationId: string, role: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-budget-${role}-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Budget User', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-budget-${suffix}`}, ${organizationId}, ${userId}, ${role})`;
  return userId;
}

for (const { name, sql } of backends) {
  test(`[${name}] a new workspace has no budget: null, never 0`, async () => {
    const tenant = await studioTenant(sql, `budget-null-${name}`);
    assert.equal(await monthlyVideoBudgetUsd(sql, tenant.organizationId), null);
    assert.equal(await monthlyVideoBudgetUsd(sql, ""), null, "no workspace in scope reads nothing");
    assert.equal(await monthlyVideoBudgetUsd(sql, "org-that-does-not-exist"), null);
  });

  test(`[${name}] an admin saves a valid budget with two decimals, and clears it with blank`, async () => {
    const tenant = await studioTenant(sql, `budget-valid-${name}`);
    const admin = await addMember(sql, tenant.organizationId, "admin");
    assert.deepEqual(await saveWorkspaceVideoBudget(sql, { userId: admin, organizationId: tenant.organizationId, value: "1250.5" }), { monthlyVideoBudgetUsd: 1250.5 });
    assert.equal(await monthlyVideoBudgetUsd(sql, tenant.organizationId), 1250.5);
    await saveWorkspaceVideoBudget(sql, { userId: admin, organizationId: tenant.organizationId, value: 0 });
    assert.equal(await monthlyVideoBudgetUsd(sql, tenant.organizationId), 0, "zero is a real budget, kept as zero");
    await saveWorkspaceVideoBudget(sql, { userId: admin, organizationId: tenant.organizationId, value: "" });
    assert.equal(await monthlyVideoBudgetUsd(sql, tenant.organizationId), null);
    const audits = await sql<{ action: string }>`select action from audit_log where organization_id = ${tenant.organizationId} and action = 'video_budget.updated'`;
    assert.equal(audits.length, 3, "each change is audited");
  });

  test(`[${name}] an invalid budget is refused and the stored value is kept`, async () => {
    const tenant = await studioTenant(sql, `budget-invalid-${name}`);
    const admin = await addMember(sql, tenant.organizationId, "owner");
    await saveWorkspaceVideoBudget(sql, { userId: admin, organizationId: tenant.organizationId, value: "300" });
    for (const value of ["-5", "10.999", "lots"]) {
      await assert.rejects(saveWorkspaceVideoBudget(sql, { userId: admin, organizationId: tenant.organizationId, value }), /at most two decimals/);
    }
    assert.equal(await monthlyVideoBudgetUsd(sql, tenant.organizationId), 300);
    // The column refuses a negative value too, whoever writes it.
    await assert.rejects(sql`update organizations set monthly_video_budget_usd = -1 where id = ${tenant.organizationId}`);
  });

  test(`[${name}] tenancy: members read, only admins write, and another workspace is never touched`, async () => {
    const a = await studioTenant(sql, `budget-ten-a-${name}`);
    const b = await studioTenant(sql, `budget-ten-b-${name}`);
    const adminA = await addMember(sql, a.organizationId, "admin");
    const adminB = await addMember(sql, b.organizationId, "admin");
    const viewerA = await addMember(sql, a.organizationId, "viewer");
    await saveWorkspaceVideoBudget(sql, { userId: adminA, organizationId: a.organizationId, value: "100" });
    await saveWorkspaceVideoBudget(sql, { userId: adminB, organizationId: b.organizationId, value: "200" });

    // The fixture's own user is a member (not an admin): it may read, and may not write.
    assert.deepEqual(await readWorkspaceVideoBudget(sql, { userId: a.userId, organizationId: a.organizationId }), { monthlyVideoBudgetUsd: 100 });
    assert.deepEqual(await readWorkspaceVideoBudget(sql, { userId: viewerA, organizationId: a.organizationId }), { monthlyVideoBudgetUsd: 100 });
    await assert.rejects(saveWorkspaceVideoBudget(sql, { userId: a.userId, organizationId: a.organizationId, value: "1" }));
    await assert.rejects(saveWorkspaceVideoBudget(sql, { userId: viewerA, organizationId: a.organizationId, value: "1" }));

    // An admin of workspace A can neither read nor change workspace B.
    await assert.rejects(readWorkspaceVideoBudget(sql, { userId: adminA, organizationId: b.organizationId }), /not available to you/);
    await assert.rejects(saveWorkspaceVideoBudget(sql, { userId: adminA, organizationId: b.organizationId, value: "9" }), /not available to you/);

    assert.equal(await monthlyVideoBudgetUsd(sql, a.organizationId), 100);
    assert.equal(await monthlyVideoBudgetUsd(sql, b.organizationId), 200);
  });
}
