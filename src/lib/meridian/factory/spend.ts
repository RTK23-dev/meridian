/**
 * The spend a Factory run is held to (NORTH_STAR section 4, caps; section 8, item 7). Only metered spend counts: a row in
 * factory_costs, written from a provider call that reported its own cost. A call whose provider reports no cost writes no row, so
 * it is not counted here, and the caps cannot see it. FACTORY.md says so.
 */
import type { Sql } from "../learning/store.ts";

/**
 * The metered spend of one run, in cents: the sum of the factory_costs rows the run's provider calls wrote, and the part of it in the
 * last 24 hours. A stage that made no metered call adds nothing.
 */
export async function meteredSpendOf(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
): Promise<{ totalCents: number; dailyCents: number }> {
  const rows = await sql<{ total: number; daily: number }>`
    select coalesce(sum(cents), 0)::int as total,
      coalesce(sum(cents) filter (where created_at >= now() - interval '1 day'), 0)::int as daily
    from factory_costs
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
  `;
  return { totalCents: Number(rows[0]?.total ?? 0), dailyCents: Number(rows[0]?.daily ?? 0) };
}

/** The brand's declared caps, from factory_spend_caps. A brand with no row has none, which reads as zero. */
export async function spendCapsOf(sql: Sql, organizationId: string, brandId: string): Promise<{ totalCents: number; dailyCents: number }> {
  const rows = await sql<{ daily_cents: number; total_cents: number }>`
    select daily_cents, total_cents from factory_spend_caps
    where organization_id = ${organizationId} and brand_id = ${brandId}
    limit 1
  `;
  return { totalCents: Number(rows[0]?.total_cents ?? 0), dailyCents: Number(rows[0]?.daily_cents ?? 0) };
}

/**
 * The cap a run is held to, in cents: the stricter of the run's own cap and the brand's declared cap, counting only the caps that are
 * set. Null when neither is set, which is how a full run without a cap is recognised.
 */
export function effectiveCap(runCents: number, brandCents: number): number | null {
  const set = [runCents, brandCents].filter((value) => value > 0);
  return set.length === 0 ? null : Math.min(...set);
}
