import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { BudgetExceededError, BudgetLedgerService, toMicros } from "./budget-ledger.ts";

async function createTenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organizationId = `org-cap-${suffix}`;
  const brandId = `brand-cap-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId };
}

async function createPlan(sql: Sql, tenant: { organizationId: string; brandId: string }, capUsd: number | null) {
  const planId = `plan-cap-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, version, status, scope, autonomy, objective,
      plan_payload, budget_reserved_usd, spend_cap_usd
    ) values (
      ${planId}, ${tenant.organizationId}, ${tenant.brandId}, '1', 'executing', 'video_only', 'semi_automatic',
      'conversion', '{}'::jsonb, 0, ${capUsd}
    )
  `;
  return planId;
}

async function accountReservedMicros(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  const account = await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId);
  return account.reservedMicros;
}

async function planState(sql: Sql, planId: string) {
  const rows = await sql<{ plan_reserved_micros: string | number | bigint }>`
    select plan_reserved_micros from creative_plans where id = ${planId}
  `;
  const reservations = await sql<{ count: number }>`
    select count(*)::int as count from budget_reservations where creative_plan_id = ${planId}
  `;
  return {
    planReservedMicros: BigInt(rows[0]!.plan_reserved_micros),
    reservationCount: Number(reservations[0]!.count),
  };
}

test("plan spend cap: a reservation above the plan cap is refused and leaves no partial state", async () => {
  const sql = await getSql();
  const tenant = await createTenant(sql, "refuse");
  const planId = await createPlan(sql, tenant, 5);

  await assert.rejects(
    BudgetLedgerService.reserve(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      amountMicros: toMicros(10),
      creativePlanId: planId,
    }),
    (error: unknown) => error instanceof BudgetExceededError && /CreativePlan spend cap exceeded/.test((error as Error).message),
  );

  // The account has room for $10 under its default $100 cap; only the plan cap refuses it.
  assert.equal(await accountReservedMicros(sql, tenant), 0n);
  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 0n, reservationCount: 0 });
});

test("plan spend cap: a reservation within the plan cap reserves in both the account and the plan", async () => {
  const sql = await getSql();
  const tenant = await createTenant(sql, "within");
  const planId = await createPlan(sql, tenant, 10);

  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    amountMicros: toMicros(4),
    creativePlanId: planId,
  });

  assert.equal(reservation.status, "RESERVED");
  assert.equal(reservation.amountMicros, 4_000_000n);
  assert.equal(await accountReservedMicros(sql, tenant), 4_000_000n);
  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 4_000_000n, reservationCount: 1 });
});

test("plan spend cap: the cap is cumulative across sequential reservations for one plan", async () => {
  const sql = await getSql();
  const tenant = await createTenant(sql, "sequential");
  const planId = await createPlan(sql, tenant, 6);
  const reserve = () =>
    BudgetLedgerService.reserve(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      amountMicros: toMicros(3),
      creativePlanId: planId,
    });

  await reserve();
  await reserve();
  await assert.rejects(reserve(), BudgetExceededError);

  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 6_000_000n, reservationCount: 2 });
  assert.equal(await accountReservedMicros(sql, tenant), 6_000_000n);
});

test("plan spend cap: concurrent reservations for one plan never exceed the cap", async () => {
  const sql = await getSql();
  const tenant = await createTenant(sql, "concurrent");
  const planId = await createPlan(sql, tenant, 6);

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      BudgetLedgerService.reserve(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        amountMicros: toMicros(3),
        creativePlanId: planId,
      }),
    ),
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "exactly two $3 reservations fit a $6 plan cap");
  for (const result of results) {
    if (result.status === "rejected") assert.ok(result.reason instanceof BudgetExceededError);
  }
  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 6_000_000n, reservationCount: 2 });
  assert.equal(await accountReservedMicros(sql, tenant), 6_000_000n);
});

test("plan spend cap: a plan with no cap is limited only by the account cap", async () => {
  const sql = await getSql();
  const tenant = await createTenant(sql, "nocap");
  const planId = await createPlan(sql, tenant, null);

  await BudgetLedgerService.reserve(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    amountMicros: toMicros(10),
    creativePlanId: planId,
  });

  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 10_000_000n, reservationCount: 1 });
});

test("plan spend cap: a plan from another tenant is refused without touching either account", async () => {
  const sql = await getSql();
  const owner = await createTenant(sql, "owner");
  const other = await createTenant(sql, "intruder");
  const planId = await createPlan(sql, owner, 50);

  await assert.rejects(
    BudgetLedgerService.reserve(sql, {
      organizationId: other.organizationId,
      brandId: other.brandId,
      amountMicros: toMicros(1),
      creativePlanId: planId,
    }),
    /CreativePlan not found for this organization and brand/,
  );

  assert.equal(await accountReservedMicros(sql, other), 0n);
  assert.equal(await accountReservedMicros(sql, owner), 0n);
  assert.deepEqual(await planState(sql, planId), { planReservedMicros: 0n, reservationCount: 0 });
});
