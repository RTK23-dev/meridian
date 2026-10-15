/**
 * Publishing a Factory run (NORTH_STAR section 8, item 8). The launch stage sends each approved creative of the run down the paths
 * its intent names:
 *
 * - organic (intent `organic` or `both`): distribution/service.ts publishes the creative to the run's organic channels. A channel
 *   with no connection records `not_connected` with its reason. A channel that takes video refuses an image with its reason.
 * - paid (intent `ad` or `both`): publishing/engine.ts creates a campaign, an ad set, an ad creative and an ad, each PAUSED. In the
 *   testing runtime that is the fixture engine. Outside it, the live Meta publisher needs a stored token, at least one targeting
 *   country (the run's own setting), and a Facebook Page and a link. A Factory run carries no Page or link yet, so a live paid publish
 *   is refused before any request, with that reason.
 *
 * An unapproved creative never reaches publish. A creative whose gate result is `block` does not either, even when it is approved.
 * Each path writes its own receipt: organic_posts for an organic post, and provider_objects with surface `paid` for a paid object. A
 * receipt is written after the provider call returns, or as a recorded failure. Nothing here sets a campaign or an ad to ACTIVE.
 */
import type { Sql } from "../learning/store.ts";
import { publishCreativeToChannels, type PublishChannelResult } from "../distribution/service.ts";
import { metaPublishEngine, publishEngineById, type PublishEngine, type PublishEngineResult } from "../publishing/engine.ts";
import { loadTenantProviderToken } from "../performance/ownership.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import type { RunSettings } from "./run-settings.ts";
import type { TrialRequest } from "../distribution/trial.ts";
import { trialDefaultForRunPage } from "../pages/store.ts";

/** The organic channel each platform a run names publishes through. A platform with no organic channel is reported, not skipped. */
export const ORGANIC_CHANNEL_BY_PLATFORM: Readonly<Record<string, string>> = {
  instagram: "instagram-reels",
  facebook: "facebook-pages",
  youtube: "youtube-shorts",
  tiktok: "tiktok-organic",
};

/** The platforms a run publishes to organically when it names none. Each is listed, and each reports its own connection state. */
export const DEFAULT_ORGANIC_PLATFORMS: readonly string[] = ["instagram", "facebook", "youtube", "tiktok"];

/** The receipt status a paid object carries after the provider created it with status PAUSED. */
const PAID_PAUSED = "paused";

export type LaunchCreative = { creativeId: string; creativeStatus: string; gateResult: string };

export type LaunchOutcome = {
  organic: { published: number; notConnected: number; failed: number; alreadyPublished: number };
  paid: { paused: number; notConnected: number; failed: number; alreadyPaused: number };
  /** Creatives a person has not approved. They are not sent to any channel. */
  unapproved: number;
  /** Approved creatives whose gate result is block. They are not sent to any channel. */
  blocked: number;
  /** Platforms the run named that have no organic channel. Each is reported, never published. */
  unmapped: string[];
  /** Receipts this launch wrote that name a post or a paused object. A launch with none has nothing to measure. */
  receipts: number;
  summary: string;
};

type Scope = { organizationId: string; brandId: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The run's creatives, in the order they were made, that a person has approved (`approved`, or `testing` once a channel has taken
 * them) and that the gate has not blocked. Everything else is counted, so the summary says why a creative was not sent.
 */
export async function launchableCreatives(
  sql: Sql,
  scope: Scope & { runId: string },
): Promise<{ eligible: LaunchCreative[]; unapproved: number; blocked: number }> {
  const rows = await sql<{ creative_id: string; creative_status: string; gate_result: string }>`
    select fc.creative_id, c.status as creative_status, v.gate_result
    from factory_creatives fc
    join creative_records c on c.id = fc.creative_id and c.organization_id = fc.organization_id and c.brand_id = fc.brand_id
    join factory_variants v on v.id = fc.variant_id and v.organization_id = fc.organization_id and v.brand_id = fc.brand_id
    -- A carousel slide is one image of its carousel. It is never posted alone; the carousel is launched as one creative.
    where fc.run_id = ${scope.runId} and fc.organization_id = ${scope.organizationId} and fc.brand_id = ${scope.brandId}
      and fc.slide_index < 0
    order by fc.created_at asc, fc.creative_id asc
  `;
  const eligible: LaunchCreative[] = [];
  let unapproved = 0;
  let blocked = 0;
  for (const row of rows) {
    const approved = row.creative_status === "approved" || row.creative_status === "testing";
    if (!approved) {
      unapproved += 1;
      continue;
    }
    if (row.gate_result === "block") {
      blocked += 1;
      continue;
    }
    eligible.push({ creativeId: row.creative_id, creativeStatus: row.creative_status, gateResult: row.gate_result });
  }
  return { eligible, unapproved, blocked };
}

/** The organic platforms this run publishes to: the ones it names, or every default platform when it names none. */
export function organicPlatformsOf(settings: Pick<RunSettings, "platforms">): string[] {
  return settings.platforms.length > 0 ? [...settings.platforms] : [...DEFAULT_ORGANIC_PLATFORMS];
}

/**
 * Publishes one creative to the run's organic channels. A channel whose platform already has a confirmed post for this creative is
 * not sent again. The channels that remain go through publishCreativeToChannels, which records each receipt.
 */
async function publishOrganic(
  sql: Sql,
  scope: Scope,
  creativeId: string,
  platforms: string[],
  actorId: string,
  trial: TrialRequest | null,
): Promise<{ results: PublishChannelResult[]; alreadyPublished: number; unmapped: string[]; error: string }> {
  const done = await sql<{ platform: string }>`
    select platform from organic_posts
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and creative_id = ${creativeId}
      and surface = 'organic' and status in ('published', 'scheduled')
  `;
  const donePlatforms = new Set(done.map((row) => row.platform));
  const channelIds: string[] = [];
  const unmapped: string[] = [];
  let alreadyPublished = 0;
  for (const platform of platforms) {
    if (donePlatforms.has(platform)) {
      alreadyPublished += 1;
      continue;
    }
    const channelId = ORGANIC_CHANNEL_BY_PLATFORM[platform];
    if (!channelId) {
      unmapped.push(platform);
      continue;
    }
    channelIds.push(channelId);
  }
  if (channelIds.length === 0) return { results: [], alreadyPublished, unmapped, error: "" };
  try {
    const results = await publishCreativeToChannels(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      creativeId,
      channelIds,
      userId: actorId,
      // The run's page default. Null is an ordinary publish, and the service applies it to Instagram only.
      trial,
    });
    return { results, alreadyPublished, unmapped, error: "" };
  } catch (error) {
    // The service refuses a creative that is not approved, or an actor who is not a member. Nothing was sent.
    return { results: [], alreadyPublished, unmapped, error: errorText(error) };
  }
}

type PaidRoute = { engine: PublishEngine; accessToken: string | null } | { notConnected: string } | { refused: string };

/** The reason a live paid publish is refused when the run names no targeting country. It is the reason the run view shows. */
export const NO_TARGETING_COUNTRY_REASON = "A live paid publish was refused: no targeting country. Name at least one targeting country on the run. Nothing was sent.";

/** The reason a live paid publish is refused when a Factory run has no Facebook Page or link to create the ad creative with. */
export const NO_PAGE_OR_LINK_REASON =
  "A live paid publish needs a Facebook Page and a destination link, and a Factory run does not carry them yet. Nothing was sent.";

/**
 * The live paid route, decided from what is known. It reads nothing and sends nothing. The checks run in order: a stored Meta token,
 * then at least one targeting country, then a Page and a link. A failed check is refused before the publisher is called, so no campaign
 * or ad set is created that the later steps cannot finish.
 */
export function liveRouteFor(input: { accessToken: string | null; countries: readonly string[]; pageId: string; link: string }): PaidRoute {
  if (!input.accessToken) {
    return { notConnected: "No Meta ads account is connected for this workspace. Connect it in Settings. Nothing was sent." };
  }
  if (input.countries.length === 0) return { refused: NO_TARGETING_COUNTRY_REASON };
  if (!input.pageId.trim() || !input.link.trim()) return { refused: NO_PAGE_OR_LINK_REASON };
  return { engine: metaPublishEngine(), accessToken: input.accessToken };
}

/**
 * The paid engine for this run. The testing runtime uses the fixture engine, which needs no token, country or Page, so it is unchanged.
 * Outside it, the route is the live one (liveRouteFor).
 */
export async function paidRouteFor(sql: Sql, scope: Scope, input: { countries: readonly string[]; pageId: string; link: string }): Promise<PaidRoute> {
  if (isTestingRuntimeNow()) return { engine: publishEngineById("test"), accessToken: null };
  const credential = await loadTenantProviderToken(sql, scope.organizationId, "meta", process.env.TOKEN_ENCRYPTION_KEY ?? "");
  return liveRouteFor({
    accessToken: credential.status === "connected" ? credential.accessToken : null,
    countries: input.countries,
    pageId: input.pageId,
    link: input.link,
  });
}

/** Records a paid publish's stages. A stage the provider confirmed is a paused object. Any other stage is a failure with its reason. */
async function recordPaidStages(
  sql: Sql,
  scope: Scope,
  provider: string,
  creativeId: string,
  result: PublishEngineResult,
): Promise<{ paused: boolean; error: string }> {
  let adPaused = false;
  let firstError = result.error ?? "";
  for (const stage of result.stages) {
    const confirmed = stage.status === "stored" && Boolean(stage.externalId);
    if (confirmed) {
      await sql`
        insert into provider_objects (
          id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, last_error, synced_at, surface
        ) values (
          ${globalThis.crypto.randomUUID()}, ${scope.organizationId}, ${scope.brandId}, ${provider}, ${stage.objectType}, ${creativeId},
          ${stage.externalId}, ${PAID_PAUSED}, '', now(), 'paid'
        )
        on conflict (organization_id, provider, object_type, idempotency_key) do update set
          external_id = excluded.external_id, status = excluded.status, last_error = '', synced_at = now()
        where provider_objects.external_id = ''
      `;
      if (stage.objectType === "ad") adPaused = true;
      continue;
    }
    const error = stage.error || "The provider did not confirm this stage. Nothing is reported as paused.";
    if (!firstError) firstError = error;
    await recordPaidFailure(sql, scope, { provider, creativeId, objectType: stage.objectType, status: "failed", reason: error });
  }
  return { paused: adPaused, error: firstError };
}

/**
 * Writes a paid failure as a receipt with no external id. A later launch may publish the creative again, and then its confirmed
 * object replaces the failure. A confirmed object is never overwritten.
 */
async function recordPaidFailure(
  sql: Sql,
  scope: Scope,
  input: { provider: string; creativeId: string; objectType: string; status: "failed" | "not_connected"; reason: string },
): Promise<void> {
  await sql`
    insert into provider_objects (
      id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, last_error, synced_at, surface
    ) values (
      ${globalThis.crypto.randomUUID()}, ${scope.organizationId}, ${scope.brandId}, ${input.provider}, ${input.objectType},
      ${input.creativeId}, '', ${input.status}, ${input.reason.slice(0, 500)}, now(), 'paid'
    )
    on conflict (organization_id, provider, object_type, idempotency_key) do update set
      status = excluded.status, last_error = excluded.last_error, synced_at = now()
    where provider_objects.external_id = ''
  `;
}

/**
 * Publishes one creative as paused paid objects, unless the creative already has a confirmed paid object for this run's brand. The run's
 * targeting countries go to the publisher, which puts them in the ad set's targeting.
 */
async function publishPaid(
  sql: Sql,
  scope: Scope,
  creativeId: string,
  input: { dailyCents: number; countries: readonly string[] },
): Promise<{ outcome: "paused" | "not_connected" | "failed" | "already"; error: string }> {
  const existing = await sql<{ external_id: string }>`
    select external_id from provider_objects
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and idempotency_key = ${creativeId}
      and object_type = 'ad' and surface = 'paid' and external_id <> '' and status = ${PAID_PAUSED}
    limit 1
  `;
  if (existing[0]) return { outcome: "already", error: "" };

  // The Factory carries no Facebook Page or link, so the live route gets empty ones and refuses with that reason.
  const route = await paidRouteFor(sql, scope, { countries: input.countries, pageId: "", link: "" });
  if ("notConnected" in route) {
    const provider = "meta";
    await recordPaidFailure(sql, scope, { provider, creativeId, objectType: "ad", status: "not_connected", reason: route.notConnected });
    return { outcome: "not_connected", error: route.notConnected };
  }
  if ("refused" in route) {
    await recordPaidFailure(sql, scope, { provider: "meta", creativeId, objectType: "ad", status: "failed", reason: route.refused });
    return { outcome: "failed", error: route.refused };
  }
  let result: PublishEngineResult;
  try {
    result = await route.engine.publishPaused({
      name: `Meridian Factory ${creativeId}`,
      dailyBudgetCents: input.dailyCents,
      countries: [...input.countries],
      pageId: "",
      link: "",
      message: "",
      accessToken: route.accessToken ?? undefined,
    });
  } catch (error) {
    const reason = `The paid publisher did not return. Nothing is reported as paused. ${errorText(error)}`;
    await recordPaidFailure(sql, scope, { provider: route.engine.id, creativeId, objectType: "ad", status: "failed", reason });
    return { outcome: "failed", error: reason };
  }
  const recorded = await recordPaidStages(sql, scope, route.engine.id, creativeId, result);
  if (recorded.paused) return { outcome: "paused", error: "" };
  return { outcome: "failed", error: recorded.error || "The paid publisher did not confirm an ad." };
}

/**
 * The launch stage. Each eligible creative is sent down the paths its intent names, in the order the Plan stage made them. Returns
 * the counts, and a summary the run row and the worker record.
 */
export async function launchFactoryRun(
  sql: Sql,
  input: Scope & { runId: string; actorId: string; settings: RunSettings },
): Promise<LaunchOutcome> {
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const { eligible, unapproved, blocked } = await launchableCreatives(sql, { ...scope, runId: input.runId });
  const wantsOrganic = input.settings.intent === "organic" || input.settings.intent === "both";
  const wantsPaid = input.settings.intent === "ad" || input.settings.intent === "both";
  const platforms = organicPlatformsOf(input.settings);
  // The page the run targets sets whether its Instagram posts start as a trial. A run with no page has no trial default.
  const trial = wantsOrganic ? await trialDefaultForRunPage(sql, scope, input.settings.pageId) : null;

  const outcome: LaunchOutcome = {
    organic: { published: 0, notConnected: 0, failed: 0, alreadyPublished: 0 },
    paid: { paused: 0, notConnected: 0, failed: 0, alreadyPaused: 0 },
    unapproved,
    blocked,
    unmapped: [],
    receipts: 0,
    summary: "",
  };

  for (const creative of eligible) {
    if (wantsOrganic) {
      const organic = await publishOrganic(sql, scope, creative.creativeId, platforms, input.actorId, trial);
      outcome.organic.alreadyPublished += organic.alreadyPublished;
      for (const platform of organic.unmapped) if (!outcome.unmapped.includes(platform)) outcome.unmapped.push(platform);
      if (organic.error) outcome.organic.failed += 1;
      for (const result of organic.results) {
        if (result.status === "published" || result.status === "scheduled") {
          outcome.organic.published += 1;
          outcome.receipts += 1;
        } else if (result.status === "not_connected") {
          outcome.organic.notConnected += 1;
        } else {
          outcome.organic.failed += 1;
        }
      }
    }
    if (wantsPaid) {
      const paid = await publishPaid(sql, scope, creative.creativeId, {
        dailyCents: input.settings.caps.dailyCents,
        countries: input.settings.targetingCountries,
      });
      if (paid.outcome === "paused") {
        outcome.paid.paused += 1;
        outcome.receipts += 1;
      } else if (paid.outcome === "already") outcome.paid.alreadyPaused += 1;
      else if (paid.outcome === "not_connected") outcome.paid.notConnected += 1;
      else outcome.paid.failed += 1;
    }
  }

  const parts = [
    `launched:organic=${outcome.organic.published}`,
    `not_connected=${outcome.organic.notConnected + outcome.paid.notConnected}`,
    `paid_paused=${outcome.paid.paused}`,
    `failed=${outcome.organic.failed + outcome.paid.failed}`,
    `unapproved=${unapproved}`,
    `blocked=${blocked}`,
  ];
  if (!wantsOrganic && !wantsPaid) parts.push("intent=none");
  if (eligible.length === 0) parts.push("nothing-approved");
  outcome.summary = parts.join(";");
  return outcome;
}

/**
 * The test stage. It records what a budget test would do, and it switches nothing on. The record is an audit row that names the paid
 * ads the run holds, and it says how many were switched on, which is always zero.
 */
export async function recordTestPlan(
  sql: Sql,
  input: Scope & { runId: string; actorId: string },
): Promise<string> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from provider_objects
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and object_type = 'ad' and surface = 'paid' and status = ${PAID_PAUSED} and external_id <> ''
      and idempotency_key in (
        select creative_id from factory_creatives
        where run_id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      )
  `;
  const pausedAds = rows[0]?.n ?? 0;
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${globalThis.crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.actorId},
      'factory.test.recorded', 'factory_run', ${input.runId},
      ${JSON.stringify({ pausedAds: String(pausedAds), switchedOn: "0", note: "Budget shifts are recorded for a person. No ad is switched on." })}
    )
  `;
  return `test:recorded;paused-ads=${pausedAds};switched-on=0`;
}

/**
 * Schedules the measurement pull for a run that has at least one receipt to measure. The scheduler enqueues `measurement.pull` on
 * this cadence, and the pull reads only the run's published posts and paused paid objects.
 */
export const MEASUREMENT_EVERY_SECONDS = 6 * 60 * 60;

export async function scheduleRunMeasurement(sql: Sql, input: Scope & { runId: string }): Promise<void> {
  await sql`
    insert into job_schedules (id, organization_id, brand_id, job_type, every_seconds, next_run, enabled, payload)
    values (
      ${`measure:${input.runId}`}, ${input.organizationId}, ${input.brandId}, 'measurement.pull', ${MEASUREMENT_EVERY_SECONDS},
      now(), true, ${JSON.stringify({ runId: input.runId })}
    )
    on conflict (id) do update set enabled = true, payload = excluded.payload
  `;
}
