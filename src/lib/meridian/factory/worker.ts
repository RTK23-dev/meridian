import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { defaultGatherDeps, gatherForRun, gatheredSummary, type GatherDeps } from "./gather.ts";
import { CREATIVE_DNA_VERSION, dnaFromTranscript, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { decodeVideoDna } from "./decode.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { combineGates, originalityGate, claimsGate, policyGate, rightsGate, brandGate, type GateVerdict } from "./gates.ts";
import { adsMustPause } from "./kill-switch.ts";
import { isFactoryStage, LEARN_NOT_BUILT } from "./pipeline.ts";
import { runSettingsFromStorage } from "./run-settings.ts";
import { stageDecision } from "./stage-decision.ts";
import { snapshotMediaAllowed } from "./sources.ts";
import { recordedClaimsOf, templateFromDna, variantMatrix } from "./template.ts";
import { buildAdTimeline } from "./timeline.ts";
import { winnerScore } from "./winner-score.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";
import { loadFactoryBrain } from "./brain-facts.ts";
import {
  gradeColumnsOf,
  gradeItemWithEngine,
  NO_DNA_GRADE,
  NO_ENGINE_GRADE,
  observedOnlyGrade,
  resolveGradeEngine,
  type GradeColumns,
  type GradeEngine,
  type GradeEngineChoice,
  type GradeItem,
} from "./grade.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The decision engines a stage may call. Production passes nothing and the stage builds the live engines; a test passes fixture
 * engines, so no engine is reached over the network.
 */
export type FactorySeams = { decisionEngines?: DecisionEngineRegistry };

/**
 * Runs one Factory stage. `deps` are the sourcing seams the discover stage uses; production passes nothing and gets the live
 * sources, and a test passes fixtures.
 */
export async function executeFactoryJob(
  sql: Sql,
  job: ExecutableJob,
  payload: Record<string, unknown>,
  deps: GatherDeps = defaultGatherDeps(),
  seams: FactorySeams = {},
): Promise<string> {
  if (!isFactoryStage(job.job_type)) throw new Error(`No factory handler for ${job.job_type}.`);
  if (!job.brand_id) throw new Error("Factory jobs need a brand.");
  const runId = text(payload.runId);
  if (!runId) throw new Error("Factory jobs need a run id.");
  const owned = await sql<{ id: string; status: string; niche: string; level: number; settings: string; created_by: string }>`
    select id, status, niche, level, settings, created_by from factory_runs
    where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    limit 1
  `;
  if (!owned[0]) throw new Error("Factory run is not owned by this organization and brand.");
  const settings = runSettingsFromStorage(owned[0].settings, owned[0].level);
  const approvals = await sql<{ n: number }>`
    select count(*)::int as n from factory_approvals
    where run_id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and stage = ${job.job_type}
  `;
  const decision = stageDecision({
    automation: settings.automation,
    stage: job.job_type,
    approved: (approvals[0]?.n ?? 0) > 0,
    killSwitchEngaged: await killSwitchPaused(sql, job.organization_id, job.brand_id),
    capCents: settings.caps.totalCents > 0 ? settings.caps.totalCents : null,
    spentCents: await meteredSpendCents(sql, job.organization_id, job.brand_id),
  });
  if (decision.action === "stop" || decision.action === "await_approval") {
    // A stage that waits or is stopped is recorded on the run with its reason. It is not a failure, and the run resumes once it clears.
    const status = decision.action === "stop" ? "paused" : "awaiting_approval";
    await sql`
      update factory_runs set status = ${status}, current_stage = ${job.job_type}, error = ${decision.reason}, updated_at = now()
      where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    `;
    return `${decision.action === "stop" ? "stopped" : "awaiting-approval"}:${job.job_type}`;
  }
  await sql`
    update factory_runs
    set status = case when status in ('queued', 'failed', 'awaiting_approval', 'paused') then 'running' else status end,
        current_stage = ${job.job_type},
        error = '',
        updated_at = now()
    where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
  `;

  if (job.job_type === "factory.discover") {
    // Every source records its own state on the run. A source that is not connected or fails does not stop the run.
    const gathered = await gatherForRun(
      sql,
      {
        organizationId: job.organization_id,
        brandId: job.brand_id,
        runId,
        jobId: job.id,
        createdBy: owned[0].created_by,
        niche: owned[0].niche,
        platforms: settings.platforms,
      },
      deps,
    );
    return gatheredSummary(gathered);
  }
  if (job.job_type === "factory.ingest") {
    const allowed = snapshotMediaAllowed();
    return allowed ? "ingest:snapshot-media-opt-in" : "ingest:metadata-only";
  }
  // The stages below record no cost. Nothing measures what they spend, so no figure is written. A cost row comes from the
  // budget ledger once a stage makes a metered provider call.
  if (job.job_type === "factory.decode") {
    const decoded = await decodeStoredAds(sql, job.organization_id, job.brand_id);
    return `decoded:${decoded}`;
  }
  if (job.job_type === "factory.grade") {
    const graded = await gradeStoredAds(sql, job.organization_id, job.brand_id, {
      runId,
      decisionEngine: settings.decisionEngine,
      engines: seams.decisionEngines,
    });
    return `graded:${graded}`;
  }
  if (job.job_type === "factory.trend") {
    const { clusterStoredCreativeDna } = await import("./trends.ts");
    const clusters = await clusterStoredCreativeDna(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
    });
    return `clustered:${clusters.length}`;
  }
  if (job.job_type === "factory.pick") {
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from ad_timelines
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and winner_score is not null
    `;
    return `picked:${rows[0]?.n ?? 0}`;
  }
  // No stage below marks the run succeeded. The run finishes only when learn does its real work (see LEARN_NOT_BUILT).
  if (job.job_type === "factory.template") {
    const made = await persistTemplates(sql, job.organization_id, job.brand_id, runId);
    return `templates:${made}`;
  }
  if (job.job_type === "factory.produce") {
    const made = await persistVariants(sql, job.organization_id, job.brand_id, runId);
    return `variants:${made}`;
  }
  if (job.job_type === "factory.gate") {
    const gated = await gateVariants(sql, job.organization_id, job.brand_id);
    return `gated:${gated}`;
  }
  if (job.job_type === "factory.review") {
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from factory_variants
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and gate_result = 'review'
    `;
    // Review reports how many variants wait for a person. It does not finish the run: the approval stop points decide where it waits.
    return `review:${rows[0]?.n ?? 0}`;
  }
  if (job.job_type === "factory.launch") {
    const caps = await sql<{ daily_cents: number; total_cents: number }>`
      select daily_cents, total_cents from factory_spend_caps
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      limit 1
    `;
    if (!caps[0] || (caps[0].daily_cents <= 0 && caps[0].total_cents <= 0)) {
      return "launch:blocked-no-cap";
    }
    return "launch:paused-until-owner";
  }
  if (job.job_type === "factory.test") {
    return "test:awaiting-live-results";
  }
  if (job.job_type === "factory.learn") {
    // Learning is not built (NORTH_STAR section 8, item 10). Nothing was learned, so the run is not finished. It stays running,
    // and the reason is on the run row where the Factory screen reads it.
    await sql`
      update factory_runs set error = ${LEARN_NOT_BUILT}, updated_at = now()
      where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    `;
    return LEARN_NOT_BUILT;
  }
  return `queued:${job.job_type}`;
}

async function decodeStoredAds(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const ads = await sql<{
    id: string;
    copy: string;
    media_duration_ms: number | null;
    media_storage_key: string;
    transcript: string | null;
    segments: string | null;
  }>`
    select a.id, a.copy, a.media_duration_ms, a.media_storage_key, t.transcript, t.segments
    from research_ads a
    left join research_transcript_cache t on t.id = a.transcript_cache_id
    where a.organization_id = ${organizationId} and a.brand_id = ${brandId}
    order by a.captured_at desc
    limit 80
  `;
  let count = 0;
  for (const ad of ads) {
    let dna: CreativeDna;
    let videoBytes: Uint8Array | null = null;
    if (ad.media_storage_key) {
      const blob = await sql<{ body: string }>`
        select body from asset_blobs
        where storage_key = ${ad.media_storage_key} and organization_id = ${organizationId} and brand_id = ${brandId}
        limit 1
      `;
      if (blob[0]?.body) {
        videoBytes = new Uint8Array(Buffer.from(blob[0].body, "base64"));
      }
    }

    if (videoBytes && videoBytes.byteLength > 0) {
      let segments: ResearchSegment[] = [];
      try {
        if (ad.segments) segments = JSON.parse(ad.segments) as ResearchSegment[];
      } catch {
        segments = [];
      }
      dna = await decodeVideoDna({
        adId: ad.id,
        videoBytes,
        durationMs: ad.media_duration_ms,
        transcript: ad.transcript,
        segments,
      });
    } else {
      const source = (ad.transcript || ad.copy || "").trim();
      dna = dnaFromTranscript({
        adId: ad.id,
        durationMs: ad.media_duration_ms ?? 0,
        transcript: source,
        format: guessFormat(source),
        schema: CREATIVE_DNA_VERSION,
      });
    }

    const id = `dna:${brandId}:${ad.id}`;
    const embSql = dna.embedding && dna.embedding.length > 0 ? `[${dna.embedding.join(",")}]` : null;
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record, embedding)
      values (${id}, ${organizationId}, ${brandId}, ${ad.id}, ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)}, ${embSql})
      on conflict (organization_id, brand_id, research_ad_id, schema_version) do update
        set record = excluded.record, embedding = excluded.embedding
    `;
    count += 1;
  }
  return count;
}

/** The delivery facts the collector stored with an ad. A row without the stop-time key predates it, so nothing is known. */
type Delivery = { stillRunning: boolean | null; countries: string[] };

function deliveryOf(sourceMetrics: string): Delivery {
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(sourceMetrics) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
  } catch {
    record = {};
  }
  if (!("stoppedAt" in record)) return { stillRunning: null, countries: [] };
  const stoppedAt = typeof record.stoppedAt === "string" && record.stoppedAt ? record.stoppedAt : null;
  const countries = Array.isArray(record.countries) ? record.countries.filter((item): item is string => typeof item === "string") : [];
  return { stillRunning: stoppedAt === null, countries };
}

/** The engine choice and run a grade is written under. */
type GradeOptions = GradeEngineChoice & { runId: string };

/** A grade as stored on an ad's timeline, with the run that wrote it. */
type StoredGrade = GradeColumns & { gradedBy: string | null };

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The grade an ad's timeline holds, or null when the ad was never graded by an engine or with observed-only wording. */
function storedGradeOf(row: Record<string, unknown>): StoredGrade | null {
  const status = row.jev_status;
  if (status !== "engine" && status !== "observed_only") return null;
  return {
    status,
    action: (nullableText(row.jev_action) as PolicyOutcome | null) ?? null,
    reason: text(row.jev_reason),
    engineId: nullableText(row.jev_engine_id),
    model: nullableText(row.jev_model),
    questionVersions: text(row.jev_question_versions) || "[]",
    policyVersion: text(row.jev_policy_version),
    gateRecordId: nullableText(row.jev_gate_record_id),
    votes: text(row.jev_votes) || "[]",
    gradedBy: nullableText(row.graded_by_run_id),
  };
}

async function gradeStoredAds(sql: Sql, organizationId: string, brandId: string, options: GradeOptions): Promise<number> {
  const ads = await sql<{
    id: string;
    page_id: string;
    advertiser: string;
    copy: string;
    captured_at: unknown;
    published_at: unknown;
    platforms: string;
    source_metrics: string;
  }>`
    select id, page_id, advertiser, copy, captured_at, published_at, platforms, source_metrics
    from research_ads
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by captured_at desc
    limit 80
  `;
  const delivered = new Map(ads.map((ad) => [ad.id, deliveryOf(ad.source_metrics)]));
  // Variants and track record are counted per advertiser page, from the ads this brand has collected.
  const variantsByPage = new Map<string, number>();
  const knownByPage = new Map<string, number>();
  const runningByPage = new Map<string, number>();
  for (const ad of ads) {
    variantsByPage.set(ad.page_id, (variantsByPage.get(ad.page_id) ?? 0) + 1);
    const stillRunning = delivered.get(ad.id)?.stillRunning;
    if (stillRunning == null) continue;
    knownByPage.set(ad.page_id, (knownByPage.get(ad.page_id) ?? 0) + 1);
    if (stillRunning) runningByPage.set(ad.page_id, (runningByPage.get(ad.page_id) ?? 0) + 1);
  }
  // The JEV grade's inputs. Each one is read from storage. The market is the brand's stored creative DNA, counted by angle; the
  // brand's own counts come from its creative records. Nothing is estimated, and an unknown value is not guessed.
  const dnaRows = await sql<{ research_ad_id: string; advertiser: string; record: string }>`
    select d.research_ad_id, coalesce(a.advertiser, '') as advertiser, d.record
    from creative_dna d
    left join research_ads a on a.id = d.research_ad_id and a.organization_id = d.organization_id and a.brand_id = d.brand_id
    where d.organization_id = ${organizationId} and d.brand_id = ${brandId} and d.schema_version = ${CREATIVE_DNA_VERSION}
  `;
  const storedDna = new Map<string, CreativeDna>();
  const marketRows: Array<{ angle: string; advertiser: string }> = [];
  for (const row of dnaRows) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    if (!dna?.adId) continue;
    storedDna.set(row.research_ad_id, dna);
    marketRows.push({ angle: dna.angle.value.trim().toLowerCase(), advertiser: row.advertiser });
  }
  const brandRows = await sql<{ angle: string; n: number }>`
    select lower(trim(angle)) as angle, count(*)::int as n from creative_records
    where organization_id = ${organizationId} and brand_id = ${brandId} and origin <> 'competitor'
    group by lower(trim(angle))
  `;
  const brandAngles = new Map(brandRows.map((row) => [row.angle, Number(row.n)]));
  const brandCreatives = [...brandAngles.values()].reduce((sum, n) => sum + n, 0);
  const brain = await loadFactoryBrain(sql, organizationId, brandId);
  // One engine for the whole run. Null means no engine is ready, so every item is graded on observed signal only.
  const engine: GradeEngine | null = await resolveGradeEngine(sql, organizationId, {
    decisionEngine: options.decisionEngine,
    engines: options.engines,
  });
  const priorRows = await sql<Record<string, unknown>>`
    select research_ad_id, jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions,
      jev_policy_version, jev_gate_record_id, jev_votes, graded_by_run_id
    from ad_timelines
    where organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  const previousGrades = new Map(priorRows.map((row) => [String(row.research_ad_id), storedGradeOf(row)]));

  let count = 0;
  for (const ad of ads) {
    const facts = delivered.get(ad.id) ?? { stillRunning: null, countries: [] };
    const known = knownByPage.get(ad.page_id) ?? 0;
    const timeline = buildAdTimeline({
      sightings: [
        {
          seenAt: String(ad.published_at || ad.captured_at),
          platforms: parseList(ad.platforms),
          countries: facts.countries,
          reachLow: null,
          reachHigh: null,
          stillRunning: facts.stillRunning,
        },
      ],
      siblingVariants: variantsByPage.get(ad.page_id) ?? 1,
    });
    if (!timeline) continue;
    const scored = winnerScore({
      daysRunning: timeline.daysRunning,
      stillRunning: timeline.stillRunning,
      iterationCount: Math.max(1, timeline.siblingVariants),
      countries: timeline.countries.length,
      platforms: timeline.platforms.length,
      // Of this advertiser's ads whose delivery the source reported, the share still delivering. Unknown when none are.
      advertiserSurvivorRate: known > 0 ? (runningByPage.get(ad.page_id) ?? 0) / known : null,
      // No quality measure is stored for an ad yet, so quality is unknown, not a fixed value.
      creativeQuality: null,
    });
    // The engine's grade, written beside the observed score and never blended into it. An ad this engine already graded with the
    // same questions keeps its grade, so a rerun does not ask the engine again.
    const dna = storedDna.get(ad.id);
    const previous = previousGrades.get(ad.id) ?? null;
    const angle = dna ? dna.angle.value.trim().toLowerCase() : "";
    let stored: StoredGrade;
    if (!engine) {
      stored = { ...gradeColumnsOf(observedOnlyGrade(NO_ENGINE_GRADE)), gradedBy: options.runId };
    } else if (!dna) {
      stored = { ...gradeColumnsOf(observedOnlyGrade(NO_DNA_GRADE)), gradedBy: options.runId };
    } else if (
      previous?.status === "engine" &&
      previous.engineId === engine.selection.engineId &&
      previous.questionVersions === JSON.stringify(engine.questionVersions)
    ) {
      stored = previous;
    } else {
      const sameAngle = marketRows.filter((row) => angle !== "" && row.angle === angle);
      const grade: GradeItem = {
        researchAdId: ad.id,
        copy: ad.copy,
        dna,
        market: {
          storedCreatives: marketRows.length,
          sameAngle: sameAngle.length,
          sameAngleAdvertisers: new Set(sameAngle.map((row) => row.advertiser).filter(Boolean)).size,
        },
        brand: { creatives: brandCreatives, sameAngle: brandAngles.get(angle) ?? 0 },
        brain: brain.values,
      };
      const judged = await gradeItemWithEngine(sql, { organizationId, brandId, item: grade }, engine);
      stored = { ...gradeColumnsOf(judged), gradedBy: options.runId };
    }
    const id = `tl:${brandId}:${ad.id}`;
    await sql`
      insert into ad_timelines (
        id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running,
        sibling_variants, platforms, countries, reach_low, reach_high, winner_score, winner_low, winner_high, evidence,
        jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions, jev_policy_version,
        jev_gate_record_id, jev_votes, graded_by_run_id
      ) values (
        ${id}, ${organizationId}, ${brandId}, ${ad.id}, ${timeline.firstSeen}, ${timeline.lastSeen}, ${timeline.stillRunning},
        ${timeline.daysRunning}, ${timeline.siblingVariants}, ${JSON.stringify(timeline.platforms)}, ${JSON.stringify(timeline.countries)},
        ${timeline.reachLow}, ${timeline.reachHigh}, ${scored.score}, ${scored.low}, ${scored.high}, ${JSON.stringify(scored.evidence)},
        ${stored.status}, ${stored.action}, ${stored.reason}, ${stored.engineId}, ${stored.model}, ${stored.questionVersions},
        ${stored.policyVersion}, ${stored.gateRecordId}, ${stored.votes}, ${stored.gradedBy}
      )
      on conflict (organization_id, brand_id, research_ad_id) do update set
        last_seen = excluded.last_seen, still_running = excluded.still_running, days_running = excluded.days_running,
        platforms = excluded.platforms, countries = excluded.countries, winner_score = excluded.winner_score,
        winner_low = excluded.winner_low, winner_high = excluded.winner_high, evidence = excluded.evidence,
        jev_status = excluded.jev_status, jev_action = excluded.jev_action, jev_reason = excluded.jev_reason,
        jev_engine_id = excluded.jev_engine_id, jev_model = excluded.jev_model,
        jev_question_versions = excluded.jev_question_versions, jev_policy_version = excluded.jev_policy_version,
        jev_gate_record_id = excluded.jev_gate_record_id, jev_votes = excluded.jev_votes,
        graded_by_run_id = excluded.graded_by_run_id, updated_at = now()
    `;
    count += 1;
  }
  return count;
}

async function persistTemplates(sql: Sql, organizationId: string, brandId: string, runId: string): Promise<number> {
  const rows = await sql<{ research_ad_id: string; record: string }>`
    select research_ad_id, record from creative_dna
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by created_at desc
    limit 10
  `;
  let count = 0;
  for (const row of rows) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    if (!dna?.adId) continue;
    const template = templateFromDna(dna);
    const id = `tpl:${runId}:${row.research_ad_id}`;
    await sql`
      insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard)
      values (${id}, ${organizationId}, ${brandId}, ${row.research_ad_id}, ${JSON.stringify(template)})
      on conflict (id) do update set storyboard = excluded.storyboard
    `;
    count += 1;
  }
  return count;
}

async function persistVariants(sql: Sql, organizationId: string, brandId: string, runId: string): Promise<number> {
  const templates = await sql<{ id: string }>`
    select id from factory_templates
    where organization_id = ${organizationId} and brand_id = ${brandId} and id like ${`tpl:${runId}:%`}
    order by created_at desc
    limit 5
  `;
  const axes = variantMatrix({
    hooks: ["question", "pattern interrupt"],
    ctas: ["shop", "learn"],
    presenters: ["founder"],
    lengthsMs: [9000, 15000],
    max: 8,
  });
  let count = 0;
  for (const template of templates) {
    for (const axis of axes) {
      const id = `var:${template.id}:${axis.hook}:${axis.cta}:${axis.presenter}:${axis.lengthMs}`;
      await sql`
        insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result)
        values (${id.slice(0, 180)}, ${organizationId}, ${brandId}, ${template.id}, ${axis.hook}, ${axis.cta}, ${axis.presenter}, ${axis.lengthMs}, 'review')
        on conflict (id) do nothing
      `;
      count += 1;
    }
  }
  return count;
}

/** Claim text is one claim per line or per semicolon. */
function splitClaimText(value: string): string[] {
  return value.split(/[\n;]/).map((item) => item.trim()).filter(Boolean);
}

/** The brand's approved claims and prohibited claims, from its product records. Empty when none are recorded. */
async function brandClaimRules(sql: Sql, organizationId: string, brandId: string): Promise<{ approved: string[]; banned: string[] }> {
  const rows = await sql<{ allowed_claims: unknown; prohibited_claims: unknown }>`
    select p.allowed_claims, p.prohibited_claims
    from products p
    join brands b on b.id = p.brand_id
    where b.id = ${brandId} and b.organization_id = ${organizationId} and b.deleted_at is null
  `;
  const approved: string[] = [];
  const banned: string[] = [];
  for (const row of rows) {
    approved.push(...splitClaimText(text(row.allowed_claims)));
    banned.push(...splitClaimText(text(row.prohibited_claims)));
  }
  return { approved, banned };
}

/**
 * The gate verdicts for one variant. Each check gets only the evidence this job has. The claims check gets the brand's
 * approved and prohibited claims and the claim text the variant's storyboard records, so a variant with no recorded claim
 * text is reviewed, not passed.
 */
export function variantGateVerdicts(input: {
  storyboard: string | null;
  rules: { approved: string[]; banned: string[] };
}): GateVerdict[] {
  return [
    originalityGate({ frameHashDistance: null, embeddingDistance: null, textSimilarity: null }),
    brandGate({ logoPresent: null, paletteMatch: null, productLooksRight: null }),
    claimsGate({ claims: recordedClaimsOf(input.storyboard ?? ""), approvedClaims: input.rules.approved, bannedWords: input.rules.banned }),
    // This job runs no policy check, so no flag is known. Unknown is review; it is never recorded as a pass.
    policyGate({ beforeAfter: null, personalAttribute: null, healthClaim: null, financeClaim: null }),
    rightsGate({ musicLicensed: false, footageLicensed: false, aiLabeled: false }),
  ];
}

/** Gates each recent variant with variantGateVerdicts and records the combined result. */
async function gateVariants(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rules = await brandClaimRules(sql, organizationId, brandId);
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_variants v
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where v.organization_id = ${organizationId} and v.brand_id = ${brandId}
    order by v.created_at desc
    limit 40
  `;
  let count = 0;
  for (const variant of variants) {
    const combined = combineGates(variantGateVerdicts({ storyboard: variant.storyboard, rules }));
    await sql`
      update factory_variants set gate_result = ${combined.result}
      where id = ${variant.id} and organization_id = ${organizationId} and brand_id = ${brandId}
    `;
    count += 1;
  }
  return count;
}

/** Spend recorded against this brand's runs, from the metered rows in factory_costs. Zero until a stage records a metered call. */
async function meteredSpendCents(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rows = await sql<{ spent: number }>`
    select coalesce(sum(cents), 0)::int as spent from factory_costs
    where organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  return rows[0]?.spent ?? 0;
}

async function killSwitchPaused(sql: Sql, organizationId: string, brandId: string): Promise<boolean> {
  const rows = await sql<{ scope: string; engaged: boolean }>`
    select scope, engaged from factory_kill_switches
    where organization_id = ${organizationId} and (brand_id is null or brand_id = ${brandId})
  `;
  return adsMustPause({
    workspaceEngaged: rows.some((row) => row.scope === "workspace" && row.engaged),
    brandEngaged: rows.some((row) => row.scope === "brand" && row.engaged),
  });
}

function guessFormat(source: string): AdFormat {
  const text = source.toLowerCase();
  if (text.includes("unbox")) return "unboxing";
  if (text.includes("testimonial") || text.includes("review")) return "testimonial";
  if (text.includes("how to") || text.includes("demo")) return "demo";
  if (text.includes("skit")) return "skit";
  return "other";
}
