// The billing page's reads and writes against a migrated database. Nothing is set by default; a viewer reads, an admin changes, a member is refused
// for every limit, another workspace's admin is refused, a brand of another workspace is refused, a value that does not fit is refused with
// nothing written, and every change is audited with its value before and after. Recorded values only; no provider is called.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { BudgetLedgerService, BudgetNotSetError, toMicros } from "../security/budget-ledger.ts";
import { readBillingPage, saveBillingLimit } from "./store.ts";

const ORG = "org_bill_a";
const OTHER = "org_bill_b";
const BRAND = "brand_bill_a";
const SECOND = "brand_bill_second";
const OTHER_BRAND = "brand_bill_b";
const ADMIN = "user_bill_admin";
const VIEWER = "user_bill_viewer";
const MEMBER = "user_bill_member";
const OUTSIDER = "user_bill_outsider";
const OTHER_ADMIN = "user_bill_other_admin";

let db: TestDatabase;

async function addMember(organizationId: string, userId: string, role: string): Promise<void> {
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@example.test`}, true) on conflict (id) do nothing`;
  await db.sql`
    insert into memberships (id, organization_id, user_id, role) values (${`mem_${organizationId}_${userId}`}, ${organizationId}, ${userId}, ${role})
    on conflict (organization_id, user_id) do update set role = excluded.role
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await seedWorkspace(db.sql, OTHER, OTHER_BRAND);
  await db.sql`insert into brands (id, organization_id, name, created_by) values (${SECOND}, ${ORG}, 'Second brand', 'test')`;
  await addMember(ORG, ADMIN, "admin");
  await addMember(ORG, VIEWER, "viewer");
  await addMember(ORG, MEMBER, "member");
  await addMember(OTHER, OTHER_ADMIN, "admin");
});

after(async () => {
  await db.close();
});

const asAdmin = (value: unknown, kind: Parameters<typeof saveBillingLimit>[1]["kind"], brandId: string | null = null) =>
  saveBillingLimit(db.sql, { userId: ADMIN, organizationId: ORG, kind, brandId, value });

describe("the billing page", () => {
  test("nothing is set by default: every limit reads as unset, and the policy is readable", async () => {
    const page = await readBillingPage(db.sql, { userId: VIEWER, organizationId: ORG });
    assert.equal(page.workspace.monthlyBudgetUsd, null);
    assert.equal(page.workspace.measureCeilingUsdPerSecond, null);
    assert.equal(page.workspace.decisionCapUsd, null);
    assert.equal(page.workspace.policyReadable, true);
    const brand = page.brands.find((row) => row.brandId === BRAND);
    assert.ok(brand, "the brand is listed");
    assert.equal(brand.brandBudgetUsd, null, "no brand budget is precoded");
    assert.equal(brand.factoryDailyCapUsd, null, "no factory cap is precoded");
    assert.equal(brand.factoryTotalCapUsd, null);
  });

  test("a member of the workspace reads the page, and a viewer cannot change it: canEdit says so", async () => {
    assert.equal((await readBillingPage(db.sql, { userId: VIEWER, organizationId: ORG })).canEdit, false);
    assert.equal((await readBillingPage(db.sql, { userId: MEMBER, organizationId: ORG })).canEdit, false);
    assert.equal((await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG })).canEdit, true);
  });

  test("a user who is not a member of the workspace cannot read its page", async () => {
    await assert.rejects(readBillingPage(db.sql, { userId: OUTSIDER, organizationId: ORG }), { message: "That workspace is not available to you." });
  });

  test("the fixed cost of a master is shown as an estimate, read-only", async () => {
    const page = await readBillingPage(db.sql, { userId: VIEWER, organizationId: ORG });
    assert.equal(page.fixedCostPerMasterUsd, 0.52, "the engine's fixed cost per master (Bible 14.2)");
  });
});

describe("saving a limit", () => {
  test("a member is refused for every limit, and nothing is written", async () => {
    for (const kind of ["workspace_monthly_budget", "measure_ceiling", "decision_cap"] as const) {
      await assert.rejects(saveBillingLimit(db.sql, { userId: MEMBER, organizationId: ORG, kind, value: "1" }), /permission|role|admin/i, `${kind} needs an admin`);
    }
    await assert.rejects(saveBillingLimit(db.sql, { userId: MEMBER, organizationId: ORG, kind: "brand_budget", brandId: BRAND, value: "1" }), /permission|role|admin/i);
    const page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.workspace.monthlyBudgetUsd, null, "the refused writes changed nothing");
    assert.equal(page.workspace.decisionCapUsd, null);
  });

  test("another workspace's admin cannot change this workspace's limits", async () => {
    await assert.rejects(saveBillingLimit(db.sql, { userId: OTHER_ADMIN, organizationId: ORG, kind: "workspace_monthly_budget", value: "5" }), { message: "That workspace is not available to you." });
  });

  test("a brand of another workspace is refused, even to that workspace's admin", async () => {
    await assert.rejects(saveBillingLimit(db.sql, { userId: ADMIN, organizationId: ORG, kind: "brand_budget", brandId: OTHER_BRAND, value: "5" }), { message: "That brand is not available to you." });
  });

  test("the monthly budget, the decision cap and the measure ceiling are saved, read back, and cleared to unset", async () => {
    await asAdmin("500.5", "workspace_monthly_budget");
    await asAdmin("0.05", "decision_cap");
    await asAdmin("1.5", "measure_ceiling");
    let page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.workspace.monthlyBudgetUsd, 500.5);
    assert.equal(page.workspace.decisionCapUsd, 0.05);
    assert.equal(page.workspace.measureCeilingUsdPerSecond, 1.5);
    await asAdmin("", "workspace_monthly_budget");
    await asAdmin("", "decision_cap");
    await asAdmin("", "measure_ceiling");
    page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.workspace.monthlyBudgetUsd, null, "a blank monthly budget is unset");
    assert.equal(page.workspace.decisionCapUsd, null, "a blank decision cap is unset: decisions are refused");
    assert.equal(page.workspace.measureCeilingUsdPerSecond, null, "a blank measure ceiling is unset: a measure run is refused");
  });

  test("a value that does not fit is refused with its reason, and nothing is written", async () => {
    await asAdmin("0.05", "decision_cap");
    await assert.rejects(asAdmin("5", "decision_cap"), /between 0\.001 and 1/);
    await assert.rejects(asAdmin("0", "measure_ceiling"), /between 0\.01 and 5/);
    await assert.rejects(asAdmin("12.345", "workspace_monthly_budget"), /with at most two decimals/);
    const page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.workspace.decisionCapUsd, 0.05, "the refused value did not replace the stored one");
  });

  test("a brand budget is set for that brand only; zero is a budget that stops the brand; a blank is refused, not a default", async () => {
    await asAdmin("250", "brand_budget", BRAND);
    let page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.brands.find((row) => row.brandId === BRAND)?.brandBudgetUsd, 250);
    assert.equal(page.brands.find((row) => row.brandId === SECOND)?.brandBudgetUsd, null, "the other brand is not changed");
    await assert.rejects(asAdmin("", "brand_budget", BRAND), /Enter 0 to stop all paid work/);
    await asAdmin("0", "brand_budget", BRAND);
    page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    assert.equal(page.brands.find((row) => row.brandId === BRAND)?.brandBudgetUsd, 0);
    await asAdmin("250", "brand_budget", BRAND);
  });

  test("a brand with no budget refuses a paid reservation, and says the budget is set on the billing page", async () => {
    await assert.rejects(
      BudgetLedgerService.reserve(db.sql, { organizationId: ORG, brandId: SECOND, amountMicros: toMicros(1) }),
      (error: unknown) => error instanceof BudgetNotSetError && /Billing page/.test(error.message),
    );
  });

  test("a brand budget cannot go below what the brand has spent or holds", async () => {
    await asAdmin("100", "brand_budget", BRAND);
    await BudgetLedgerService.reserve(db.sql, { organizationId: ORG, brandId: BRAND, amountMicros: toMicros(30) });
    await assert.rejects(asAdmin("20", "brand_budget", BRAND), /cannot be below the \$30\.00 already spent or held/);
    const page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    const brand = page.brands.find((row) => row.brandId === BRAND);
    assert.equal(brand?.brandBudgetUsd, 100, "the refused lower budget changed nothing");
    assert.equal(brand?.committedUsd, 30);
  });

  test("factory caps are saved per brand in cents, the daily cap cannot be above the total cap, and a blank unsets it", async () => {
    await asAdmin("50", "factory_total_cap", BRAND);
    await asAdmin("10", "factory_daily_cap", BRAND);
    let page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    let brand = page.brands.find((row) => row.brandId === BRAND);
    assert.equal(brand?.factoryTotalCapUsd, 50);
    assert.equal(brand?.factoryDailyCapUsd, 10);
    assert.equal(page.brands.find((row) => row.brandId === SECOND)?.factoryDailyCapUsd, null, "a cap belongs to one brand");
    await assert.rejects(asAdmin("60", "factory_daily_cap", BRAND), /cannot be above its total cap/);
    await asAdmin("", "factory_daily_cap", BRAND);
    page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    brand = page.brands.find((row) => row.brandId === BRAND);
    assert.equal(brand?.factoryDailyCapUsd, null, "a blank daily cap is unset, and the factory refuses until it is set");
    assert.equal(brand?.factoryTotalCapUsd, 50);
  });

  test("every change is audited with the value before and after, under the billing action names", async () => {
    const rows = await db.sql<{ action: string; metadata: string }>`
      select action, metadata::text as metadata from audit_log
      where organization_id = ${ORG} and action like 'billing.%' order by created_at
    `;
    assert.ok(rows.length > 10, "each saved change left a row");
    const monthly = rows.filter((row) => row.action === "billing.workspace_monthly_budget.updated");
    assert.ok(monthly.length >= 2);
    const parsed = JSON.parse(monthly[0]!.metadata) as { before: unknown; after: unknown };
    assert.ok("before" in parsed && "after" in parsed, "the audit row carries the value before and after");
    assert.ok(rows.some((row) => row.action === "billing.brand_budget.updated"), "brand budget changes are audited too");
  });
});

describe("a limit and its audit row are one transaction", () => {
  test("when the audit row cannot be written, the limit is not saved", async () => {
    await db.sql`
      create or replace function billing_test_fail_audit() returns trigger as $$ begin raise exception 'audit unavailable'; end $$ language plpgsql
    `;
    await db.sql`
      create trigger billing_test_fail_audit before insert on audit_log for each row
      when (new.action = 'billing.factory_daily_cap.updated') execute function billing_test_fail_audit()
    `;
    try {
      await assert.rejects(
        saveBillingLimit(db.sql, { userId: ADMIN, organizationId: ORG, kind: "factory_daily_cap", brandId: SECOND, value: 5 }),
        /audit unavailable/,
      );
      const rows = await db.sql<{ daily_cents: number }>`select daily_cents from factory_spend_caps where organization_id = ${ORG} and brand_id = ${SECOND}`;
      assert.equal(rows.length, 0, "no cap was written without its audit row");
    } finally {
      await db.sql`drop trigger if exists billing_test_fail_audit on audit_log`;
      await db.sql`drop function if exists billing_test_fail_audit()`;
    }
  });
});

describe("two limits saved at the same moment", () => {
  test("the decision cap and the measure ceiling both keep their value", async () => {
    await Promise.all([
      saveBillingLimit(db.sql, { userId: ADMIN, organizationId: ORG, kind: "decision_cap", brandId: null, value: 0.04 }),
      saveBillingLimit(db.sql, { userId: ADMIN, organizationId: ORG, kind: "measure_ceiling", brandId: null, value: 0.02 }),
    ]);
    const page = await readBillingPage(db.sql, { userId: ADMIN, organizationId: ORG });
    const text = JSON.stringify(page);
    assert.match(text, /0\.04/);
    assert.match(text, /0\.02/);
  });
});
