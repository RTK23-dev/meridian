/**
 * The spend a Factory run is held to (NORTH_STAR section 4, caps; section 8, items 2 and 7). Only metered spend counts: the rows in
 * factory_costs that carry a cost. A provider call that reports its own cost, and a decision whose model has a published price, are
 * counted. A decision whose model has no price is recorded in tokens and is not counted. FACTORY.md says so.
 */
import type { Sql } from "../learning/store.ts";

/** One micro-dollar is a millionth of a dollar. One cent is 10,000 micro-dollars. */
const MICROS_PER_CENT = 10_000;

/**
 * The metered spend of one run, in whole cents: the priced cost of its factory_costs rows, and the part of it in the last 24 hours.
 * A provider-reported row counts its cents. A token row counts its priced micro-dollars, and a token row with no price (micros null)
 * counts nothing: unpriced spend is not counted by caps. The total is rounded up to a whole cent, so a cap is never under-counted.
 * A stage that made no metered call adds nothing.
 */
export async function meteredSpendOf(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
): Promise<{ totalCents: number; dailyCents: number }> {
  const rows = await sql<{ total: number; daily: number }>`
    select
      coalesce(sum(coalesce(micros, cents::bigint * 10000)), 0)::float8 as total,
      coalesce(sum(coalesce(micros, cents::bigint * 10000)) filter (where created_at >= now() - interval '1 day'), 0)::float8 as daily
    from factory_costs
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
  `;
  return {
    totalCents: Math.ceil(Number(rows[0]?.total ?? 0) / MICROS_PER_CENT),
    dailyCents: Math.ceil(Number(rows[0]?.daily ?? 0) / MICROS_PER_CENT),
  };
}

/** One run's spend as the run view states it: what was priced, what was only metered in tokens, and what provider calls reported. */
export type RunSpend = {
  /** The priced cost of the run's token decisions, in micro-dollars. Unpriced decisions add nothing here. */
  pricedMicros: number;
  /** Decisions that were metered and priced. */
  pricedDecisions: number;
  /** Decisions that were metered in tokens only, because the model has no price. Their cost is unknown, not zero. */
  tokenOnlyDecisions: number;
  /** Prompt and completion tokens over every token decision that reported them. */
  tokens: number;
  /** Cents the provider calls reported. */
  providerCents: number;
};

/**
 * The spend each run of a brand has, read from factory_costs. A run with no rows has no entry. Tokens are summed only where the engine
 * reported them. Nothing here is estimated.
 */
export async function runSpendFor(sql: Sql, organizationId: string, brandId: string, runIds: string[]): Promise<Map<string, RunSpend>> {
  const result = new Map<string, RunSpend>();
  if (runIds.length === 0) return result;
  const rows = await sql<{
    run_id: string;
    basis: string;
    cents: number | null;
    micros: number | string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
  }>`
    select run_id, basis, cents, micros, prompt_tokens, completion_tokens from factory_costs
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = any(${runIds})
  `;
  for (const row of rows) {
    const current = result.get(row.run_id) ?? { pricedMicros: 0, pricedDecisions: 0, tokenOnlyDecisions: 0, tokens: 0, providerCents: 0 };
    if (row.basis === "tokens") {
      if (row.micros === null) current.tokenOnlyDecisions += 1;
      else {
        current.pricedMicros += Number(row.micros);
        current.pricedDecisions += 1;
      }
      current.tokens += (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0);
    } else {
      current.providerCents += row.cents ?? 0;
    }
    result.set(row.run_id, current);
  }
  return result;
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

/** A run with no cost rows: nothing was metered, so every figure is zero and there is nothing to price. */
export const NO_RUN_SPEND: RunSpend = { pricedMicros: 0, pricedDecisions: 0, tokenOnlyDecisions: 0, tokens: 0, providerCents: 0 };
