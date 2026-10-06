import type { Sql } from "../learning/store.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { startOperation } from "../observability/redact.ts";
import { loadProviderInsights } from "./fetch.ts";
import { ingestPerformanceRows } from "./sync.ts";

type Job = { id: string; organization_id: string; brand_id: string | null };

/** Learning runs only after at least one new observation is stored. */
export function shouldEnqueueLearning(storedCount: number): boolean {
  return storedCount > 0;
}

/** Fetches provider insights and stores only rows that pass the normalizer. */
export async function runPerformanceSync(
  sql: Sql,
  job: Job,
  payload: Record<string, unknown>,
  transport: Transport = liveTransport(),
): Promise<string> {
  const provider = typeof payload.provider === "string" ? payload.provider : "meta";
  const operation = startOperation({
    provider,
    operation: "performance.sync",
    organizationId: job.organization_id,
    brandId: job.brand_id ?? "",
  });
  if (!job.brand_id) throw new Error("Performance sync needs a brand.");
  const creativeId = typeof payload.creativeId === "string" ? payload.creativeId : "";
  const externalAdId = typeof payload.externalAdId === "string" ? payload.externalAdId : "";
  const currency = typeof payload.currency === "string" ? payload.currency : "";
  const timezone = typeof payload.timezone === "string" ? payload.timezone : "";
  const loaded = await loadProviderInsights(
    {
      provider,
      externalAdId,
      creativeId,
      currency,
      timezone,
      startDate: typeof payload.startDate === "string" ? payload.startDate : "",
      endDate: typeof payload.endDate === "string" ? payload.endDate : "",
      env: process.env,
    },
    transport,
  );
  if ("error" in loaded) {
    operation.finish(false, 1, loaded.error);
    throw new Error(loaded.error);
  }
  const prior = await sql<{ external_id: string; creative_id: string; impressions: number; clicks: number; conversions: number; spend_cents: number; revenue_cents: number; observed_on: string }>`
    select external_id, creative_id, impressions, clicks, conversions, spend_cents, revenue_cents, observed_on
    from performance_observations
    where organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and external_id <> ''
  `;
  const existing = prior.map((row) => ({
    externalId: row.external_id,
    creativeId: row.creative_id,
    impressions: row.impressions,
    reach: null,
    clicks: row.clicks,
    conversions: row.conversions,
    spendCents: row.spend_cents,
    revenueCents: row.revenue_cents,
    currency,
    timezone,
    observedOn: String(row.observed_on).slice(0, 10),
  }));
  const ingested = ingestPerformanceRows(existing, loaded.events);
  const platform = provider === "tiktok" || provider === "google" ? provider : "meta";
  for (const event of ingested.stored) {
    await sql`
      insert into performance_observations (
        id, organization_id, brand_id, creative_id, platform, impressions, clicks, conversions,
        spend_cents, revenue_cents, observed_on, source, created_by, external_id
      )
      select
        ${crypto.randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${event.creativeId}, ${platform},
        ${event.impressions}, ${event.clicks}, ${event.conversions ?? 0}, ${event.spendCents}, ${event.revenueCents},
        ${event.observedOn}, ${platform}, 'performance.sync', ${event.externalId}
      where not exists (
        select 1 from performance_observations existing
        where existing.organization_id = ${job.organization_id} and existing.external_id = ${event.externalId}
      )
    `;
  }
  const record = operation.finish(true, 1, `stored:${ingested.stored.length}`);
  if (!shouldEnqueueLearning(ingested.stored.length)) return `stored:0;duplicates:${ingested.duplicates};correlation:${record.correlationId}`;
  const learningId = crypto.randomUUID();
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, depends_on)
    values (
      ${learningId}, ${job.organization_id}, ${job.brand_id}, 'learning.update',
      ${`learn:${job.id}`}, 'queued', ${JSON.stringify({ organizationId: job.organization_id })}, ${job.id}
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, depends_on)
    values (
      ${crypto.randomUUID()}, ${job.organization_id}, ${job.brand_id}, 'opportunity.refresh',
      ${`refresh:${job.id}`}, 'queued', ${JSON.stringify({ organizationId: job.organization_id })}, ${learningId}
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
  return `stored:${ingested.stored.length};correlation:${record.correlationId}`;
}
