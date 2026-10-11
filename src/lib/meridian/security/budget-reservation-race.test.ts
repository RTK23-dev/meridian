import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { BudgetLedgerService, BudgetExceededError, toMicros, toUsd } from "./budget-ledger.ts";

test("Budget Reservation Concurrency: race condition prevention under parallel requests", async () => {
  const sql = await getSql();
  const orgId = "org-race-" + Date.now();
  const brandId = "brand-race-" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Race Org', ${orgId}, 'test-user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Race Brand', 'test-user') on conflict do nothing`;

  // Reservations tied to a plan require that plan to exist for this tenant (fail closed).
  for (let i = 0; i < 5; i += 1) {
    await sql`insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id) values (${`plan-race-${orgId}-${i}`}, ${orgId}, ${brandId}, '1', 'executing', 'video_only', 'semi_automatic', 'conversion', '{}'::jsonb, 0, null, 'jev-test-decision') on conflict do nothing`;
  }

  // 1. Initialize account with exact $10.00 cap
  const initialCapUsd = 10.0;
  const account = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId, initialCapUsd);
  assert.equal(account.maxSpendMicros, 10_000_000n);

  // 2. Launch 5 concurrent parallel reservation requests of $3.00 each
  // Total attempted: $15.00 against a $10.00 cap.
  const reserveAmount = toMicros(3.0); // 3_000_000 micros
  const promises = Array.from({ length: 5 }, (_, i) =>
    BudgetLedgerService.reserve(sql, {
      organizationId: orgId,
      brandId,
      amountMicros: reserveAmount,
      creativePlanId: `plan-race-${orgId}-${i}`,
    })
  );

  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  // Invariant: Exactly 3 reservations succeed (3 * $3 = $9 <= $10 cap)
  assert.equal(fulfilled.length, 3, "Exactly 3 reservations must succeed");
  // Invariant: Exactly 2 reservations fail with BudgetExceededError
  assert.equal(rejected.length, 2, "Exactly 2 reservations must be rejected");

  for (const rej of rejected) {
    if (rej.status === "rejected") {
      assert.ok(
        rej.reason instanceof BudgetExceededError,
        `Expected BudgetExceededError, got: ${rej.reason?.message}`
      );
    }
  }

  // 3. Verify database state
  const updatedAccount = await BudgetLedgerService.getOrCreateAccount(sql, orgId, brandId);
  const totalCommitted = updatedAccount.spentMicros + updatedAccount.reservedMicros;
  assert.equal(updatedAccount.reservedMicros, 9_000_000n);
  assert.ok(
    totalCommitted <= updatedAccount.maxSpendMicros,
    `Committed budget ($${toUsd(totalCommitted)}) must never exceed cap ($${toUsd(updatedAccount.maxSpendMicros)})`
  );
});
