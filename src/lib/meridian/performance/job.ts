import type { Sql } from "../learning/store.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { startOperation } from "../observability/redact.ts";
import { loadProviderInsights } from "./fetch.ts";
import { ingestPerformanceRows } from "./sync.ts";
import { loadTenantProviderToken, validatePerformanceOwnership } from "./ownership.ts";
import { verifyMetaAdAccountAccess } from "../providers/meta.ts";

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
  const ownership = await validatePerformanceOwnership(sql, {
    organizationId: job.organization_id,
    brandId: job.brand_id,
    creativeId,
    externalAdId,
    provider,
  });
  if (!ownership.ok) throw new Error(ownership.error);
  if (provider !== "meta" && provider !== "tiktok" && provider !== "google") {
    operation.finish(false, 1, `${provider} performance sync is not implemented.`);
    throw new Error(`${provider} performance sync is not implemented. No observations were stored.`);
  }
  // Metrics are read only through the workspace's own connected account. The token is its sealed OAuth token. Without one, the
  // job records NOT_CONNECTED and makes no provider request. No environment token is used.
  const credential = await loadTenantProviderToken(sql, job.organization_id, provider, process.env.TOKEN_ENCRYPTION_KEY ?? "");
  if (credential.status === "NOT_CONNECTED") {
    await markNotConnected(sql, job.organization_id, provider, credential.error);
    operation.finish(false, 0, credential.error);
    throw new Error(`NOT_CONNECTED: ${credential.error}`);
  }
  if (provider === "meta") {
    const account = await verifyMetaAdAccountAccess(credential.accessToken, externalAdId, transport);
    if (!account.ok) {
      operation.finish(false, 1, account.error);
      throw new Error(account.error);
    }
  }
  const loaded = await loadProviderInsights(
    {
      provider,
      externalAdId,
      creativeId,
      currency,
      timezone,
      startDate: typeof payload.startDate === "string" ? payload.startDate : "",
      endDate: typeof payload.endDate === "string" ? payload.endDate : "",
      accessToken: credential.accessToken,
      // The Google Ads developer token identifies the deployment's API client. It is not an account token, and the job reads it
      // from the deployment, the same as the customer and advertiser ids.
      developerToken: provider === "google" ? (process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "") : undefined,
      advertiserId: process.env.TIKTOK_ADVERTISER_ID,
      customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
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

async function markNotConnected(sql: Sql, organizationId: string, provider: string, detail: string): Promise<void> {
  await sql`
    update provider_connections set status = 'NOT_CONNECTED', last_error = ${detail}, updated_at = now()
    where organization_id = ${organizationId} and provider = ${provider}
  `;
}
