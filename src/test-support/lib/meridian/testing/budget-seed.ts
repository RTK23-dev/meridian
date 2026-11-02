// A brand budget for a test that reserves against it. Production has no default brand budget (a brand with none refuses paid work), so a test
// that reserves states the budget it runs under. The value is the one the old default gave, so existing expectations hold.
import type { Sql } from "../../../../lib/meridian/learning/store.ts";
import { BudgetLedgerService } from "../../../../lib/meridian/security/budget-ledger.ts";

export const TEST_BRAND_BUDGET_USD = 100;

/** Sets the brand's budget for the test, through the same account the Billing page writes. */
export async function seedTestBrandBudget(sql: Sql, organizationId: string, brandId: string, capUsd: number = TEST_BRAND_BUDGET_USD): Promise<void> {
  await BudgetLedgerService.getOrCreateAccount(sql, organizationId, brandId, capUsd);
}

/** The brand's factory caps for a test that spends in the factory: generous, so the test's own caps decide. A test that sets caps overwrites them. */
export async function seedTestBrandCaps(sql: Sql, organizationId: string, brandId: string): Promise<void> {
  await sql`
    insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
    values (${organizationId}, ${brandId}, 100000, 1000000, 'test-user')
    on conflict (organization_id, brand_id) do nothing
  `;
}
