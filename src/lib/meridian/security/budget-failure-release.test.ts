import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { BudgetLedgerService, toMicros } from "./budget-ledger.ts";

test("Budget Failure Release: failed production jobs release reserved funds completely", async () => {
  const sql = await getSql();
  const orgId = "org-release-" + Date.now();
  const brandId = "brand-release-" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Release Org', ${orgId}, 'user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Release Brand', 'user') on conflict do nothing`;

  // 1. Initialize account with $10.00 cap
  await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, 10.0);

  // 2. Reserve $5.00
  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: orgId,
    brandId,
    amountMicros: toMicros(5.0),
    creativePlanId: "plan-fail-1",
  });
  assert.equal(reservation.status, "RESERVED");

  let account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  assert.equal(account.reservedMicros, 5_000_000n);

  // 3. Simulate failure and release reservation
  const released = await BudgetLedgerService.release(sql, {
    reservationId: reservation.id,
    reason: "Provider timed out after 3 retries",
  });
  assert.equal(released, true);

  // 4. Verify account balance restored completely
  account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  assert.equal(account.reservedMicros, 0n, "Reserved budget must return to 0");
  assert.equal(account.spentMicros, 0n, "Spent budget must remain 0");

  // 5. Verify subsequent reservation of the full $10.00 cap succeeds
  const fullReservation = await BudgetLedgerService.reserve(sql, {
    organizationId: orgId,
    brandId,
    amountMicros: toMicros(10.0),
    creativePlanId: "plan-retry-1",
  });
  assert.equal(fullReservation.status, "RESERVED");
  assert.equal(fullReservation.amountMicros, 10_000_000n);
});
