/**
 * The learn stage of a Factory run (NORTH_STAR section 8, item 10). It recomputes the brand's learned patterns per surface, organic
 * and paid, from the stored outcomes, and records what each surface learned. A run finishes here only when its own creatives have a
 * measured outcome on a surface. Until then the run stays running, and the run row says what it waits for. Learning never waits for a
 * person: the stop points come before it.
 */

import type { Sql } from "../learning/store.ts";
import { applyLearnedPatternsBySurface, type LearningSummary } from "../learning/store.ts";

/** The reason a run stays running at learn: none of its own creatives has a measured outcome stored yet. */
export const LEARN_WAITING = "Learning waits for a measured outcome from this run's creatives. None is stored yet, so the run stays running.";

export type RunOutcomes = { organic: number; paid: number };

/**
 * The measured outcomes of this run's creatives, per surface. A metric row counts only when it carries a measured metric. A row
 * whose metrics are all unknown is not an outcome, because unknown is not a measurement.
 */
export async function runOutcomesOf(sql: Sql, input: { organizationId: string; brandId: string; runId: string }): Promise<RunOutcomes> {
  const rows = await sql<{ surface: string; n: number }>`
    select t.source_type as surface, count(*)::int as n
    from unified_performance_telemetry t
    where t.organization_id = ${input.organizationId} and t.brand_id = ${input.brandId} and t.creative_id <> ''
      and t.source_type in ('organic', 'paid')
      and (t.impressions is not null or t.clicks is not null or t.conversions is not null or t.spend_cents is not null
        or t.views is not null or t.shares is not null or t.hook_retention_3s is not null or t.completion_rate is not null)
      and t.creative_id in (
        select creative_id from factory_creatives
        where run_id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      )
    group by t.source_type
  `;
  const outcomes: RunOutcomes = { organic: 0, paid: 0 };
  for (const row of rows) {
    if (row.surface === "organic") outcomes.organic = Number(row.n);
    if (row.surface === "paid") outcomes.paid = Number(row.n);
  }
  return outcomes;
}

/**
 * Runs the learn stage for one run and returns the job result. Patterns are recomputed for the brand, per surface, so the run's
 * learning is what the next run's Pick reads. The run row is updated: finished when the run has its own measured outcome, otherwise
 * left running with the reason.
 */
export async function learnForRun(sql: Sql, input: { organizationId: string; brandId: string; runId: string }): Promise<string> {
  const learned: LearningSummary = await applyLearnedPatternsBySurface(sql, input.organizationId, input.brandId);
  const outcomes = await runOutcomesOf(sql, input);
  const perSurface = `organic ${learned.bySurface.organic.patterns} patterns from ${learned.bySurface.organic.outcomes} outcomes; `
    + `paid ${learned.bySurface.paid.patterns} patterns from ${learned.bySurface.paid.outcomes} outcomes`;
  if (outcomes.organic + outcomes.paid === 0) {
    await sql`
      update factory_runs set error = ${LEARN_WAITING}, updated_at = now()
      where id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    return `learn:waiting;${perSurface}`;
  }
  await sql`
    update factory_runs set status = 'succeeded', error = '', updated_at = now()
    where id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  return `learned:${learned.patterns};run outcomes organic ${outcomes.organic}, paid ${outcomes.paid};${perSurface}`;
}
