import { assertSameTenant, type ObservedCreative } from "../domain.ts";
import type { Sql } from "../learning/store.ts";
import { learningJobKey } from "../jobs/runner.ts";
import { ingestPerformance } from "../providers/boundaries.ts";
import type { PerformanceEvent } from "../performance/normalize.ts";

export const HYPIT_TEST_PERFORMANCE_SOURCE = "test:performance";

export type HypitPerformanceReceipt = {
  status: string;
  provider: string;
  organizationId: string;
  brandId: string;
  externalId: string;
  hypitJobId: string;
  sha256: string;
  jevDecisionId: string;
  briefId: string;
  storageKey: string;
};

export type HypitPerformanceRequest = {
  receipt: HypitPerformanceReceipt | null;
  creative: ObservedCreative;
  observedOn: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
  existing: PerformanceEvent[];
};

export type HypitPerformanceRecord = {
  source: typeof HYPIT_TEST_PERFORMANCE_SOURCE;
  platform: "test";
  synthetic: true;
  externalId: string;
  creativeId: string;
  jevDecisionId: string;
  briefId: string;
  hypitJobId: string;
  storageKey: string;
  publishingExternalId: string;
  sha256: string;
  learningJobKey: string;
  event: PerformanceEvent;
};

export type HypitPerformanceResult =
  | { stored: false; duplicate: false; reason: string }
  | { stored: true; duplicate: true; record: HypitPerformanceRecord }
  | { stored: true; duplicate: false; record: HypitPerformanceRecord };

function performanceId(externalId: string): string {
  return `${externalId}:day`;
}

/**
 * One synthetic observation for a Hypit asset already accepted by the test publisher.
 * Live ad accounts are not called. A missing receipt never becomes performance.
 */
export function planHypitTestPerformance(input: HypitPerformanceRequest): HypitPerformanceResult {
  const receipt = input.receipt;
  if (!receipt || receipt.status !== "TEST_PUBLISHED" || receipt.provider !== "test" || !receipt.externalId.startsWith("test:")) {
    return { stored: false, duplicate: false, reason: "Only a test publishing receipt can receive test performance. Nothing was stored." };
  }
  if (!receipt.hypitJobId.trim() || !receipt.sha256.trim() || !receipt.storageKey.trim()) {
    return { stored: false, duplicate: false, reason: "The publishing receipt has no Hypit artifact. Nothing was stored." };
  }
  assertSameTenant(
    [input.creative, { organizationId: receipt.organizationId, brandId: receipt.brandId }],
    input.creative.organizationId,
    input.creative.brandId,
  );
  if (!input.creative.id.trim()) return { stored: false, duplicate: false, reason: "Performance needs the stored creative. Nothing was stored." };
  const event: PerformanceEvent = {
    externalId: performanceId(receipt.externalId),
    creativeId: input.creative.id,
    impressions: input.impressions,
    reach: null,
    clicks: input.clicks,
    conversions: input.conversions,
    spendCents: input.spendCents,
    revenueCents: input.revenueCents,
    currency: "USD",
    timezone: "UTC",
    observedOn: input.observedOn,
  };
  const ingested = ingestPerformance({
    provider: "test",
    allowTestProvider: true,
    existing: input.existing,
    events: [event],
  });
  if (ingested.status !== "STORED") {
    return { stored: false, duplicate: false, reason: ingested.detail };
  }
  const record: HypitPerformanceRecord = {
    source: HYPIT_TEST_PERFORMANCE_SOURCE,
    platform: "test",
    synthetic: true,
    externalId: event.externalId,
    creativeId: input.creative.id,
    jevDecisionId: receipt.jevDecisionId,
    briefId: receipt.briefId,
    hypitJobId: receipt.hypitJobId,
    storageKey: receipt.storageKey,
    publishingExternalId: receipt.externalId,
    sha256: receipt.sha256,
    learningJobKey: learningJobKey(event.externalId),
    event,
  };
  if (ingested.events.length === 0) return { stored: true, duplicate: true, record };
  return { stored: true, duplicate: false, record };
}

/** Writes the test observation and the existing learning job. A replay does not insert again. */
export async function persistHypitTestPerformance(sql: Sql, input: HypitPerformanceRequest, actorId: string): Promise<HypitPerformanceResult> {
  const planned = planHypitTestPerformance(input);
  if (!planned.stored || planned.duplicate) return planned;
  const record = planned.record;
  await sql`
    insert into performance_observations (
      id, organization_id, brand_id, creative_id, platform, impressions, clicks, conversions,
      spend_cents, revenue_cents, observed_on, source, created_by, external_id
    )
    select
      ${crypto.randomUUID()}, ${input.creative.organizationId}, ${input.creative.brandId},
      ${record.creativeId}, ${record.platform}, ${record.event.impressions}, ${record.event.clicks}, ${record.event.conversions},
      ${record.event.spendCents}, ${record.event.revenueCents}, ${record.event.observedOn}, ${record.source}, ${actorId}, ${record.externalId}
    where not exists (
      select 1 from performance_observations existing
      where existing.organization_id = ${input.creative.organizationId} and existing.external_id = ${record.externalId}
    )
  `;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
    values (
      ${crypto.randomUUID()}, ${input.creative.organizationId}, ${input.creative.brandId}, 'learning.update',
      ${record.learningJobKey}, 'queued',
      ${JSON.stringify({
        organizationId: input.creative.organizationId,
        source: record.source,
        synthetic: true,
        hypitJobId: record.hypitJobId,
        publishingExternalId: record.publishingExternalId,
        jevDecisionId: record.jevDecisionId,
        briefId: record.briefId,
      })}
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
  return planned;
}
