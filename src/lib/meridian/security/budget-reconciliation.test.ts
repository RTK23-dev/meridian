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

  // 1. Initialize account with $20.00 cap
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 20.0);

  // 2. Reserve $2.00
  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: orgId,
    brandId,
    amountMicros: toMicros(2.0),
    creativePlanId: "plan-recon-1",
  });
  assert.equal(reservation.status, "RESERVED");
  assert.equal(reservation.amountMicros, 2_000_000n);

  let account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  assert.equal(account.reservedMicros, 2_000_000n);
  assert.equal(account.spentMicros, 0n);

  // 3. Reconcile with actual spend of $1.25
  const actualSpend = toMicros(1.25); // 1_250_000 micros
  const { reservation: reconciled, unusedReleasedMicros } = await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    actualSpentMicros: actualSpend,
  });

  // Verify unused released diff is $0.75
  assert.equal(unusedReleasedMicros, 750_000n, "Unused reservation diff of $0.75 must be released");
  assert.equal(reconciled.status, "RECONCILED");

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
  assert.equal(entries.length, 2, "Must contain RESERVATION_CREATED and RESERVATION_RECONCILED");
  assert.equal(entries[0].entry_type, "RESERVATION_CREATED");
  assert.equal(entries[1].entry_type, "RESERVATION_RECONCILED");
  assert.equal(BigInt(entries[1].delta_spent_micros), 1_250_000n);
  assert.equal(BigInt(entries[1].delta_reserved_micros), -2_000_000n);
});
