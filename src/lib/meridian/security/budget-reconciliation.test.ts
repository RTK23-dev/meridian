import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { BudgetLedgerService, toMicros, toUsd } from "./budget-ledger.ts";

test("Budget Reconciliation: actual spend transfers to spent and releases unused reservation diff", async () => {
  const sql = await getSql();
  const orgId = "org-recon-" + Date.now();
  const brandId = "brand-recon-" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Recon Org', ${orgId}, 'user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Recon Brand', 'user') on conflict do nothing`;

  // Reservations tied to a plan require that plan to exist for this tenant (fail closed).
  await sql`insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id) values (${`plan-recon-${orgId}`}, ${orgId}, ${brandId}, '1', 'executing', 'video_only', 'semi_automatic', 'conversion', '{}'::jsonb, 0, null, 'jev-test-decision') on conflict do nothing`;

  // 1. Initialize account with $20.00 cap
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 20.0);

  // 2. Reserve $2.00
  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: orgId,
    brandId,
    amountMicros: toMicros(2.0),
    creativePlanId: `plan-recon-${orgId}`,
  });
  assert.equal(reservation.status, "RESERVED");
  assert.equal(reservation.amountMicros, 2_000_000n);

  let account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  assert.equal(account.reservedMicros, 2_000_000n);
  assert.equal(account.spentMicros, 0n);

  // 3. Reconcile with actual spend of $1.25
  const actualSpend = toMicros(1.25); // 1_250_000 micros
  const { reservation: reconciled, unusedReleasedMicros, alreadyReconciled } = await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    actualSpentMicros: actualSpend,
  });

  // Verify unused released diff is $0.75
  assert.equal(unusedReleasedMicros, 750_000n, "Unused reservation diff of $0.75 must be released");
  assert.equal(reconciled.status, "RECONCILED");
  assert.equal(alreadyReconciled, false);

  const retry = await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    actualSpentMicros: actualSpend,
  });
  assert.equal(retry.alreadyReconciled, true);
  assert.equal(retry.unusedReleasedMicros, unusedReleasedMicros);

  // Verify account balances
  account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  assert.equal(account.spentMicros, 1_250_000n, "Account spent must reflect actual $1.25 spend");
  assert.equal(account.reservedMicros, 0n, "Account reserved must be reduced back to $0.00");
  assert.equal(toUsd(account.spentMicros), 1.25);

  // 4. Ledger verification
  const entries = await sql<{
    entry_type: string;
    delta_spent_micros: string | number | bigint;
    delta_reserved_micros: string | number | bigint;
  }>`
    select entry_type, delta_spent_micros, delta_reserved_micros
    from budget_ledger_entries
    where reservation_id = ${reservation.id}
    order by created_at asc
  `;
  assert.equal(entries.length, 2, "Duplicate reconciliation must not add another ledger entry");
  assert.equal(entries[0].entry_type, "RESERVATION_CREATED");
  assert.equal(entries[1].entry_type, "RESERVATION_RECONCILED");
  assert.equal(BigInt(entries[1].delta_spent_micros), 1_250_000n);
  assert.equal(BigInt(entries[1].delta_reserved_micros), -2_000_000n);
});

test("Budget Reconciliation: overage is durable, explicit, and blocks new reservations", async () => {
  const sql = await getSql();
  const orgId = "org-overage-" + Date.now();
  const brandId = "brand-overage-" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Overage Org', ${orgId}, 'user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Overage Brand', 'user') on conflict do nothing`;
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 20);
  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: orgId,
    brandId,
    amountMicros: toMicros(1),
  });

  const result = await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    actualSpentMicros: toMicros(1.5),
  });
  assert.equal(result.overageMicros, toMicros(0.5));

  const accountRows = await sql<{ status: string; spent_micros: string | number | bigint; reserved_micros: string | number | bigint }>`
    select status, spent_micros, reserved_micros from budget_accounts
    where organization_id = ${orgId} and brand_id = ${brandId}
  `;
  assert.equal(accountRows[0].status, "EXCEEDED");
  assert.equal(BigInt(accountRows[0].spent_micros), toMicros(1.5));
  assert.equal(BigInt(accountRows[0].reserved_micros), 0n);

  const ledger = await sql<{ entry_type: string }>`
    select entry_type from budget_ledger_entries where reservation_id = ${reservation.id} order by created_at desc limit 1
  `;
  assert.equal(ledger[0].entry_type, "RESERVATION_OVERAGE");
  await assert.rejects(
    BudgetLedgerService.reserve(sql, { organizationId: orgId, brandId, amountMicros: toMicros(0.01) }),
    /Budget limit exceeded/
  );
});

test("Budget Reconciliation: estimated cost is settled with provenance and never stored as provider actual", async () => {
  const sql = await getSql();
  const suffix = Date.now();
  const orgId = `org-estimated-${suffix}`;
  const brandId = `brand-estimated-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Estimated Org', ${orgId}, 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Estimated Brand', 'user')`;
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 10);
  const reservation = await BudgetLedgerService.reserve(sql, { organizationId: orgId, brandId, amountMicros: toMicros(2) });

  await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    cost: { basis: "ESTIMATED", amountMicros: toMicros(1.25), estimatorVersion: "test-estimator-v1" },
  });
  const rows = await sql<{ actual_spent_micros: unknown; estimated_spent_micros: unknown; settled_spend_micros: unknown; cost_basis: string; estimator_version: string }>`
    select actual_spent_micros, estimated_spent_micros, settled_spend_micros, cost_basis, estimator_version
    from budget_reservations where id = ${reservation.id}
  `;
  assert.equal(rows[0].actual_spent_micros, null);
  assert.equal(BigInt(rows[0].estimated_spent_micros as string), toMicros(1.25));
  assert.equal(BigInt(rows[0].settled_spend_micros as string), toMicros(1.25));
  assert.equal(rows[0].cost_basis, "ESTIMATED");
  assert.equal(rows[0].estimator_version, "test-estimator-v1");
});

test("Budget Reconciliation: unknown cost remains reserved instead of being represented as actual", async () => {
  const sql = await getSql();
  const suffix = Date.now();
  const orgId = `org-unknown-${suffix}`;
  const brandId = `brand-unknown-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Unknown Org', ${orgId}, 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Unknown Brand', 'user')`;
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 10);
  const reservation = await BudgetLedgerService.reserve(sql, { organizationId: orgId, brandId, amountMicros: toMicros(2) });

  await assert.rejects(BudgetLedgerService.reconcile(sql, { reservationId: reservation.id, cost: { basis: "UNKNOWN" } }), /Unknown provider cost/);
  const rows = await sql<{ status: string; actual_spent_micros: unknown; reserved_micros: string | number | bigint }>`
    select r.status, r.actual_spent_micros, a.reserved_micros
    from budget_reservations r join budget_accounts a on a.id = r.account_id where r.id = ${reservation.id}
  `;
  assert.equal(rows[0].status, "RESERVED");
  assert.equal(rows[0].actual_spent_micros, null);
  assert.equal(BigInt(rows[0].reserved_micros), toMicros(2));
});

test("Budget Reconciliation: inconsistent account balance cannot partially finalize or release a reservation", async () => {
  const sql = await getSql();
  const suffix = Date.now();
  const orgId = `org-inconsistent-${suffix}`;
  const brandId = `brand-inconsistent-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Inconsistent Org', ${orgId}, 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Inconsistent Brand', 'user')`;
  const account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 10);
  const reservation = await BudgetLedgerService.reserve(sql, { organizationId: orgId, brandId, amountMicros: toMicros(2) });
  await sql`update budget_accounts set reserved_micros = 0 where id = ${account.id}`;

  await assert.rejects(BudgetLedgerService.reconcile(sql, { reservationId: reservation.id, actualSpentMicros: toMicros(1) }), /already released/);
  assert.equal(await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: "test" }), false);
  const rows = await sql<{ status: string; actual_spent_micros: unknown; ledger_count: number }>`
    select r.status, r.actual_spent_micros,
      (select count(*)::int from budget_ledger_entries l where l.reservation_id = r.id) as ledger_count
    from budget_reservations r where r.id = ${reservation.id}
  `;
  assert.equal(rows[0].status, "RESERVED");
  assert.equal(rows[0].actual_spent_micros, null);
  assert.equal(rows[0].ledger_count, 1);
});
