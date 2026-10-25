// A test helper: sets a workspace's monthly budget in US dollars. Paid generation is blocked without one (providers/generation-ledger.ts),
// so a test that expects a paid call to run gives its workspace a budget first. A test that checks the refusal leaves the budget unset.

import type { Sql } from "../learning/store.ts";

export async function setMonthlyBudget(sql: Sql, organizationId: string, usd: number): Promise<void> {
  await sql`update organizations set monthly_video_budget_usd = ${usd} where id = ${organizationId}`;
}
