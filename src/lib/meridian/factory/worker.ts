import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { defaultGatherDeps, gatherForRun, gatheredSummary, type GatherDeps } from "./gather.ts";
import { CREATIVE_DNA_VERSION, dnaFromTranscript, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { decodeVideoDna } from "./decode.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { combineGates, originalityGate, claimsGate, policyGate, rightsGate, brandGate, type GateVerdict } from "./gates.ts";
import { creativeIdsOfVariant, licencesForCreatives, variantLicenceFlags } from "./rights.ts";
import { adsMustPause } from "./kill-switch.ts";
import { isFactoryStage } from "./pipeline.ts";
import { clearLearnRecheck, learnForRun, scheduleLearnRecheck } from "./learn.ts";
import { loadSavedFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { holdoutItemIds } from "./sleep-holdout.ts";
import { runSettingsFromStorage } from "./run-settings.ts";
import { recordDecisionSpend } from "./decision-spend.ts";
import { queueStagesFrom } from "./queue-stages.ts";
import { KILL_SWITCH_STOP_REASON, stageDecision } from "./stage-decision.ts";
import { brandCapFiguresOf, capOrNull, capStopForRun, meteredSpendOf, pauseRunEngineSpend } from "./spend.ts";
import { produceFactoryCreatives, scheduleProduceRecheck } from "./produce.ts";
import { predictionFingerprint, type GradeRecord } from "./prediction.ts";
import type { FactoryEngineSeams } from "./produce-shared.ts";
import { launchFactoryRun, recordTestPlan, scheduleRunMeasurement } from "./publish.ts";
import { snapshotMediaAllowed } from "./sources.ts";
import { recordedClaimsOf, templateFromDna } from "./template.ts";
import {
  brainEntriesOf,
  controlAttributesOf,
  creativePlanFor,
  parseStoredPlan,
  storedPlanOf,
  variantsOf,
  type PlanAttributes,
  type PlanRun,
} from "./plan.ts";
import { conceptOf } from "./pick.ts";
import { linesOf } from "./brain-facts.ts";
import { buildAdTimeline } from "./timeline.ts";
import { deliveryFactsOf } from "../research/store.ts";
import { winnerScore } from "./winner-score.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";
import { loadFactoryBrain } from "./brain-facts.ts";
import { learningScopesOf, pickConceptsForRun } from "./pick.ts";
import {
  cappedGradeReason,
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
 * engines, so no engine is reached over the network. The video engine's seams (readiness and the fields a request needs) are passed the same way.
 */
export type FactorySeams = { decisionEngines?: DecisionEngineRegistry; engine?: FactoryEngineSeams };

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
  const owned = await sql<{ id: string; status: string; niche: string; level: number; settings: string; created_by: string; current_stage: string; waiting_on: string }>`
    select id, status, niche, level, settings, created_by, current_stage, waiting_on from factory_runs
    where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    limit 1
  `;
  if (!owned[0]) throw new Error("Factory run is not owned by this organization and brand.");
  // A run waiting for a provider job (a video still at the provider) holds every stage but the one it waits at. The waiting stage checks
  // again on its own schedule, and it is the only stage that may run until the wait clears.
  if (owned[0].waiting_on !== "" && owned[0].waiting_on !== job.job_type) {
    return `held:${job.job_type}`;
  }
  // A run that is waiting for a person, or stopped, holds every stage after the one it stopped at. A stage returns successfully, so
  // the queue would otherwise run the stages after it, and the run would be marked running again. Only the stage it waits at may
  // decide, and it does so when it is run again after an approval or a cleared stop.
  if ((owned[0].status === "awaiting_approval" || owned[0].status === "paused") && owned[0].current_stage !== job.job_type) {
    return `held:${job.job_type}`;
  }
  const settings = runSettingsFromStorage(owned[0].settings, owned[0].level);
  const approvals = await sql<{ n: number }>`
    select count(*)::int as n from factory_approvals
    where run_id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and stage = ${job.job_type}
  `;
  const spend = await meteredSpendOf(sql, job.organization_id, job.brand_id, runId);
  const autoApproveReview = job.job_type === "factory.review" && job.brand_id
    ? (await loadSavedFactoryPipelineConfig(sql, job.organization_id, job.brand_id))?.gradingThresholds.autoApproveEnabled === true
    : false;
  const decision = stageDecision({
    automation: settings.automation,
    stage: job.job_type,
    approved: (approvals[0]?.n ?? 0) > 0,
    killSwitchEngaged: await killSwitchPaused(sql, job.organization_id, job.brand_id),
    capCents: settings.caps.totalCents,
    spentCents: spend.totalCents,
    dailyCapCents: settings.caps.dailyCents,
    dailySpentCents: spend.dailyCents,
    // The brand's caps are held against the brand's spend across all its runs, not this run's spend alone.
    ...(await brandCapFiguresOf(sql, job.organization_id, job.brand_id)),
    autoApproveReview,
  });
  if (decision.action === "stop" || decision.action === "await_approval") {
    // A stage that waits or is stopped is recorded on the run with its reason. It is not a failure. The stages after it hold until
    // a person approves the stage it waits at, or the stop is cleared and that stage runs again.
    const status = decision.action === "stop" ? "paused" : "awaiting_approval";
    // A stopped run stops its video engine requests too: the engine's jobs run in the queue whether or not the run does (spend.ts).
    if (decision.action === "stop") await pauseRunEngineSpend(sql, job.organization_id, job.brand_id, runId, decision.reason);
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
  // The stages below record no cost of their own. The grade stage meters each engine decision's tokens (decision-spend.ts), and the
  // produce stage meters each image judgment. A provider call that reports its own cost is metered where it is made.
  if (job.job_type === "factory.decode") {
    const decoded = await decodeStoredAds(sql, job.organization_id, job.brand_id);
    return `decoded:${decoded}`;
  }
  if (job.job_type === "factory.grade") {
    const graded = await gradeStoredAds(sql, job.organization_id, job.brand_id, {
      runId,
      decisionEngine: settings.decisionEngine,
      engines: seams.decisionEngines,
      // The run's own caps. The brand's caps are checked inside each engine call (capStopForRun).
      caps: { totalCents: capOrNull(settings.caps.totalCents), dailyCents: capOrNull(settings.caps.dailyCents) },
    });
    if (graded.stop) {
      // A cap or the kill switch refused an engine call inside this stage. A refused ad keeps its stored engine grade, or records the reason
      // it has none. The run stops here with the reason on the run row, as produce stops (produce-shared.ts), and the stages after grade hold.
      await sql`
        update factory_runs set status = 'paused', current_stage = ${job.job_type}, waiting_on = '', error = ${graded.stop}, updated_at = now()
        where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      `;
      return `stopped:${job.job_type}`;
    }
    return `graded:${graded.count}`;
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
    // The picks are the concepts this run makes next, chosen from the graded ads (pick.ts). At most the run's variant cap of
    // concepts is picked, because each pick produces at least one variant.
    // The learned weights are read per surface (learningScopesOf): an organic run reads organic patterns, a paid run paid patterns, and
    // a run with intent both reads each surface for its own arm of a concept, never the other's.
    const picked = await pickConceptsForRun(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
      runId,
      maxPicks: settings.caps.maxVariants,
      learning: learningScopesOf(settings),
    });
    return `picked:${picked.picks.length}`;
  }
  // No stage below marks the run succeeded. The run finishes only when learn finds a measured outcome of its own (see learn.ts).
  if (job.job_type === "factory.template") {
    const line = job.brand_id ? await savedPlanLine(sql, job.organization_id, job.brand_id) : null;
    const planned = await persistTemplates(sql, job.organization_id, job.brand_id, runId, {
      formats: settings.formats,
      automation: settings.automation,
      intent: settings.intent,
      capTotalCents: settings.caps.totalCents,
      video: line?.video ?? null,
      briefPrompt: line?.briefPrompt ?? null,
    });
    return `templates:${planned.templates};plans:${planned.plans};refused:${planned.refused.length}`;
  }
  if (job.job_type === "factory.produce") {
    const line = job.brand_id ? await loadSavedFactoryPipelineConfig(sql, job.organization_id, job.brand_id) : null;
    const videosPerConcept = settings.formats.includes("video") ? line?.generationParams.videoCount ?? null : null;
    const dailyCap = line?.generationParams.dailyGenerationCap ?? null;
    const made = await persistVariants(sql, job.organization_id, job.brand_id, runId, settings.caps.maxVariants, videosPerConcept, dailyCap);
    const videoChoice = settings.providers.video;
    const lineProvider = !videoChoice || videoChoice === "auto" ? line?.generationParams.provider : undefined;
    // Each variant is materialized through the production router with the run's provider choice. A named provider that is not ready,
    // a cap that is reached, or a budget that refuses the reservation stops the run here, with the reason on the run row.
    const produced = await produceFactoryCreatives(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
      runId,
      formats: settings.formats,
      providers: lineProvider ? { ...settings.providers, video: lineProvider } : settings.providers,
      lineDirection: line
        ? { pacing: line.generationParams.renderPacing, scriptPrompt: line.prompts.scriptPrompt }
        : null,
      caps: { totalCents: capOrNull(settings.caps.totalCents), dailyCents: capOrNull(settings.caps.dailyCents) },
      costPerMasterUsd: settings.costPerMasterUsd,
      engines: seams.decisionEngines,
      engine: seams.engine,
    });
    if (produced.stop) {
      // A run that stops at a cap also stops its engine requests. A stop for any other reason leaves each request inside its own budget.
      const capReached = await capStopForRun(sql, job.organization_id, job.brand_id, runId, {
        totalCents: capOrNull(settings.caps.totalCents),
        dailyCents: capOrNull(settings.caps.dailyCents),
      });
      if (capReached) await pauseRunEngineSpend(sql, job.organization_id, job.brand_id, runId, capReached);
      await sql`
        update factory_runs set status = 'paused', current_stage = ${job.job_type}, waiting_on = '', error = ${produced.stop}, updated_at = now()
        where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      `;
      return `stopped:${job.job_type}`;
    }
    if (produced.waiting) {
      const note = produced.notes.length > 0 ? `${produced.notes.join(" ")} ` : "";
      await sql`
        update factory_runs set status = 'running', current_stage = ${job.job_type}, waiting_on = ${job.job_type}, error = ${`${note}${produced.waiting}`}, updated_at = now()
        where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      `;
      await scheduleProduceRecheck(sql, { organizationId: job.organization_id, brandId: job.brand_id, runId, niche: owned[0].niche });
      return `waiting:${job.job_type};creatives:${produced.produced}`;
    }
    // Every variant is produced or has its reason. The wait, if there was one, is over, so the stages after produce are queued from gate.
    const wasWaiting = owned[0].waiting_on !== "";
    const skipped = produced.notes.join(" ").slice(0, 500);
    await sql`
      update factory_runs set waiting_on = '', error = ${skipped}, updated_at = now()
      where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    `;
    if (wasWaiting && payload.resumeWait === true) {
      const queued = await queueStagesFrom(sql, {
        organizationId: job.organization_id,
        brandId: job.brand_id,
        runId,
        niche: owned[0].niche,
        fromStage: "factory.gate",
        kind: "resume",
        token: job.id,
      });
      return `variants:${made};creatives:${produced.produced};resumed:${queued}`;
    }
    return `variants:${made};creatives:${produced.produced}`;
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
    // The approved creatives go down the paths the run's intent names. Organic posts go through the distribution service, and paid
    // objects through the publishing engine, created paused. An unapproved creative is not sent. A creative with a receipt to measure
    // schedules the run's measurement pull.
    const launched = await launchFactoryRun(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
      runId,
      actorId: owned[0].created_by,
      settings,
    });
    if (launched.receipts > 0) {
      await scheduleRunMeasurement(sql, { organizationId: job.organization_id, brandId: job.brand_id, runId });
    }
    return launched.summary;
  }
  if (job.job_type === "factory.test") {
    // The budget test is recorded and waits for a person in every mode. Nothing is switched on here: the record names the paused ads
    // the run holds, and the switched-on count is always zero.
    if ((approvals[0]?.n ?? 0) === 0) {
      const reason = "The budget test is recorded for a person to approve. Nothing is switched on.";
      await sql`
        update factory_runs set status = 'awaiting_approval', current_stage = ${job.job_type}, error = ${reason}, updated_at = now()
        where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      `;
      return `awaiting-approval:${job.job_type}`;
    }
    return recordTestPlan(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
      runId,
      actorId: owned[0].created_by,
    });
  }
  if (job.job_type === "factory.learn") {
    // Learning recomputes the brand's patterns per surface. The run finishes here only when its own creatives have a measured outcome;
    // otherwise it stays running, and the scheduler checks it again on the measurement cadence.
    const result = await learnForRun(sql, { organizationId: job.organization_id, brandId: job.brand_id, runId });
    if (result.startsWith("learn:waiting") && job.brand_id) {
      await scheduleLearnRecheck(sql, {
        organizationId: job.organization_id,
        brandId: job.brand_id,
        runId,
        niche: text(payload.niche),
      });
    } else if (result.startsWith("learned:")) {
      await clearLearnRecheck(sql, runId);
    }
    return result;
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
        organizationId,
        sql,
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

/** The caps a grade's engine calls are held to, in cents: the run's effective caps, null where none is set. */
type GradeCaps = { totalCents: number | null; dailyCents: number | null };

/** The engine choice and run a grade is written under. */
type GradeOptions = GradeEngineChoice & { runId: string; caps: GradeCaps };

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

async function gradeStoredAds(
  sql: Sql,
  organizationId: string,
  brandId: string,
  options: GradeOptions,
): Promise<{ count: number; stop: string | null }> {
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
  const delivered = new Map(ads.map((ad) => [ad.id, deliveryFactsOf(ad.source_metrics)]));
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
  // The first reason an engine call was refused in this stage, or null. Every ad is still written, so a refused ad is never left unrecorded.
  let stop: string | null = null;
  for (const ad of ads) {
    const facts = delivered.get(ad.id) ?? { stillRunning: null, countries: null };
    const known = knownByPage.get(ad.page_id) ?? 0;
    const timeline = buildAdTimeline({
      sightings: [
        {
          seenAt: String(ad.published_at || ad.captured_at),
          platforms: parseList(ad.platforms),
          countries: facts.countries ?? [],
          reachLow: null,
          reachHigh: null,
          stillRunning: facts.stillRunning,
        },
      ],
      siblingVariants: variantsByPage.get(ad.page_id) ?? 1,
    });
    if (!timeline) continue;
    const countryCount = facts.countries === null ? null : timeline.countries.length;
    let platformCount: number | null;
    try {
      const parsed = JSON.parse(ad.platforms) as unknown;
      platformCount = Array.isArray(parsed) ? timeline.platforms.length : null;
    } catch {
      platformCount = null;
    }
    const scored = winnerScore({
      daysRunning: timeline.daysRunning,
      stillRunning: timeline.stillRunning,
      iterationCount: Math.max(1, timeline.siblingVariants),
      countries: countryCount,
      platforms: platformCount,
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
      // This ad needs a provider call. The kill switch and the caps are read before it, so a cap reached earlier in the stage refuses
      // the call: the ad is written observed-only with the reason, and no provider call is made.
      const refused = await gradeCallStop(sql, { organizationId, brandId, runId: options.runId, caps: options.caps });
      if (refused) {
        // A grade the engine already stored is kept: a cap does not discard it. An ad with none records the reason it has no grade.
        stored =
          previous?.status === "engine"
            ? previous
            : { ...gradeColumnsOf(observedOnlyGrade(cappedGradeReason(refused))), gradedBy: options.runId };
        stop = stop ?? refused;
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
        // The decision's tokens are metered for this run. A grade the engine answered from its own record never reaches this line, so a
        // rerun writes no row for it.
        if (judged.status === "engine") {
          await recordDecisionSpend(sql, {
            organizationId,
            brandId,
            runId: options.runId,
            stage: "factory.grade",
            gateRecordId: judged.gateRecordId,
            engineCalled: judged.engineCalled,
            engineId: judged.engineId,
            requestedModel: judged.requestedModel,
            returnedModel: judged.returnedModel,
            usage: judged.usage ?? undefined,
          });
        }
      }
    }
    const countriesJson = facts.countries === null ? "null" : JSON.stringify(timeline.countries);
    const id = `tl:${brandId}:${ad.id}`;
    await keepEarlierGrade(sql, organizationId, brandId, ad.id, previous, stored);
    await sql`
      insert into ad_timelines (
        id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running,
        sibling_variants, platforms, countries, reach_low, reach_high, winner_score, winner_low, winner_high, evidence,
        jev_status, jev_action, jev_reason, jev_engine_id, jev_model, jev_question_versions, jev_policy_version,
        jev_gate_record_id, jev_votes, graded_by_run_id
      ) values (
        ${id}, ${organizationId}, ${brandId}, ${ad.id}, ${timeline.firstSeen}, ${timeline.lastSeen}, ${timeline.stillRunning},
        ${timeline.daysRunning}, ${timeline.siblingVariants}, ${JSON.stringify(timeline.platforms)}, ${countriesJson},
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
  return { count, stop };
}

function gradeRecordOf(grade: StoredGrade): GradeRecord {
  return {
    jev_status: grade.status,
    jev_action: grade.action,
    jev_reason: grade.reason,
    jev_engine_id: grade.engineId,
    jev_model: grade.model,
    jev_question_versions: grade.questionVersions,
    jev_policy_version: grade.policyVersion,
    jev_gate_record_id: grade.gateRecordId,
  };
}

/** Copies the grade a new grade replaces. The same grade is not copied again, and the copy is never updated. */
async function keepEarlierGrade(
  sql: Sql,
  organizationId: string,
  brandId: string,
  researchAdId: string,
  previous: StoredGrade | null,
  next: StoredGrade,
): Promise<void> {
  if (!previous) return;
  const fingerprint = predictionFingerprint(gradeRecordOf(previous));
  if (fingerprint === predictionFingerprint(gradeRecordOf(next))) return;
  await sql`
    insert into ad_timeline_grades (
      id, organization_id, brand_id, research_ad_id, fingerprint, jev_status, jev_action, jev_reason,
      jev_engine_id, jev_model, jev_question_versions, jev_policy_version, jev_gate_record_id, graded_by_run_id
    ) values (
      ${`grade:${brandId}:${researchAdId}:${fingerprint}`}, ${organizationId}, ${brandId}, ${researchAdId}, ${fingerprint},
      ${previous.status}, ${previous.action}, ${previous.reason}, ${previous.engineId}, ${previous.model},
      ${previous.questionVersions}, ${previous.policyVersion}, ${previous.gateRecordId}, ${previous.gradedBy ?? ""}
    )
    on conflict (organization_id, brand_id, research_ad_id, fingerprint) do nothing
  `;
}

/**
 * The reason a grade's engine call is refused now, or null. The kill switch and the run's caps are read before each call, against the
 * spend recorded so far, so a cap reached earlier in the stage refuses the next call and the call that would pass it is not made. The
 * caps and the rule are the stage check's own (capStopReason), as produce reads them before each call.
 */
async function gradeCallStop(sql: Sql, input: { organizationId: string; brandId: string; runId: string; caps: GradeCaps }): Promise<string | null> {
  if (await killSwitchPaused(sql, input.organizationId, input.brandId)) return KILL_SWITCH_STOP_REASON;
  return capStopForRun(sql, input.organizationId, input.brandId, input.runId, input.caps);
}

/** The run's settings the plan reads. The plan takes its formats, automation, intent and spend cap from the run, and nothing else. */
type PlanSettings = PlanRun & {
  video?: { aspectRatio: "9:16" | "1:1" | "16:9" | "4:5"; durationSeconds: number } | null;
  briefPrompt?: string | null;
};

async function savedPlanLine(sql: Sql, organizationId: string, brandId: string) {
  const line = await loadSavedFactoryPipelineConfig(sql, organizationId, brandId);
  if (!line) return null;
  return {
    video: { aspectRatio: line.generationParams.aspectRatio, durationSeconds: line.generationParams.durationSeconds },
    briefPrompt: line.prompts.briefPrompt,
  };
}

/**
 * The storyboard and the CreativePlan of each pick of this run (NORTH_STAR section 5, plan). The storyboard is the framework of the
 * pick's winning ad, read from its creative DNA. The plan needs the engine decision the ad was graded under, and the brand's product.
 * A pick with neither gets a storyboard and no plan, and the reason is returned, so no variant is written for it.
 */
async function persistTemplates(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
  settings: PlanSettings,
): Promise<{ templates: number; plans: number; refused: string[] }> {
  const picks = await sql<{
    research_ad_id: string;
    record: string;
    winner_score: number | null;
    jev_gate_record_id: string | null;
    jev_reason: string;
  }>`
    select p.research_ad_id, d.record, t.winner_score, t.jev_gate_record_id, t.jev_reason
    from factory_picks p
    join creative_dna d on d.research_ad_id = p.research_ad_id and d.organization_id = p.organization_id
      and d.brand_id = p.brand_id and d.schema_version = ${CREATIVE_DNA_VERSION}
    left join ad_timelines t on t.research_ad_id = p.research_ad_id and t.organization_id = p.organization_id and t.brand_id = p.brand_id
    where p.run_id = ${runId} and p.organization_id = ${organizationId} and p.brand_id = ${brandId}
    order by p.score desc, p.id
  `;
  const brain = await loadFactoryBrain(sql, organizationId, brandId);
  const product = await sql<{ name: string }>`
    select p.name from products p
    join brands b on b.id = p.brand_id
    where p.brand_id = ${brandId} and b.organization_id = ${organizationId}
    order by p.created_at asc, p.id asc
    limit 1
  `;
  const productName = product[0]?.name ?? "";
  const audience = linesOf(brain.values.targetCustomers)[0] ?? "";
  const now = new Date().toISOString();
  let templates = 0;
  let plans = 0;
  const refused: string[] = [];
  for (const row of picks) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    const concept = dna?.adId ? conceptOf(dna) : null;
    if (!concept) continue;
    const template = templateFromDna(dna);
    const templateId = `tpl:${runId}:${row.research_ad_id}`;
    const attributes = controlAttributesOf(dna);
    let plan = "";
    if (!row.jev_gate_record_id) {
      // No engine decision backs the item, so the plan has no lineage. The grade's own reason is recorded with the refusal.
      refused.push(`${concept.label}: ${row.jev_reason || "no engine decision backs this ad"}`);
    } else {
      try {
        const creativePlan = creativePlanFor({
          templateId,
          concept,
          attributes,
          decisionId: row.jev_gate_record_id,
          researchAdId: row.research_ad_id,
          winnerScore: Number(row.winner_score ?? 0),
          productName,
          audience,
          run: settings,
          now,
          video: settings.video,
          briefPrompt: settings.briefPrompt,
        });
        plan = storedPlanOf(attributes, creativePlan);
        plans += 1;
      } catch (error) {
        refused.push(`${concept.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sql`
      insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard, plan)
      values (${templateId}, ${organizationId}, ${brandId}, ${row.research_ad_id}, ${JSON.stringify(template)}, ${plan})
      on conflict (id) do update set storyboard = excluded.storyboard, plan = excluded.plan
    `;
    templates += 1;
  }
  return { templates, plans, refused };
}

async function variantsMadeToday(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from factory_variants
    where organization_id = ${organizationId} and brand_id = ${brandId} and created_at >= date_trunc('day', now())
  `;
  return rows[0]?.n ?? 0;
}

/**
 * The variants of each planned pick (NORTH_STAR section 5, plan). A pick gets its control, and one variant for each entry the brain
 * supplies, changing one attribute. Every row records the attribute it tests: "control" for the control. The run's variant cap bounds
 * the rows written across all picks, and a pick the cap has no room for gets none.
 */
async function persistVariants(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
  maxVariants: number,
  videosPerConcept: number | null = null,
  dailyCap: number | null = null,
): Promise<number> {
  const templates = await sql<{ id: string; plan: string }>`
    select id, plan from factory_templates
    where organization_id = ${organizationId} and brand_id = ${brandId} and id like ${`tpl:${runId}:%`} and plan <> ''
    order by created_at asc, id asc
  `;
  const brain = await loadFactoryBrain(sql, organizationId, brandId);
  const entries = brainEntriesOf(brain.values);
  const held = holdoutItemIds(await sql<{ item_id: string; arm: string }>`
    select item_id, arm from factory_holdouts
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
  `);
  const madeToday = dailyCap === null ? 0 : await variantsMadeToday(sql, organizationId, brandId);
  let dailyRoom = dailyCap === null ? Number.POSITIVE_INFINITY : Math.max(0, dailyCap - madeToday);
  let budget = Math.max(0, maxVariants);
  let count = 0;
  for (const template of templates) {
    if (budget <= 0 || dailyRoom <= 0) break;
    if (held.has(template.id)) continue;
    const stored = parseStoredPlan(template.plan);
    if (!stored) continue;
    const control: PlanAttributes = stored.attributes;
    const room = videosPerConcept === null ? budget : Math.min(budget, Math.max(0, videosPerConcept));
    const rows: Array<{ attribute: string; attributes: PlanAttributes }> = [
      { attribute: "control", attributes: control },
      ...variantsOf(control, entries, Math.max(0, room - 1)).map((variant) => ({ attribute: variant.attribute, attributes: variant.attributes })),
    ].slice(0, room);
    let considered = 0;
    for (const [index, row] of rows.entries()) {
      if (dailyRoom <= 0) break;
      const id = `var:${template.id}:${index}`;
      const inserted = await sql<{ id: string }>`
        insert into factory_variants (
          id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result, tests_attribute, angle, format, proof
        ) values (
          ${id.slice(0, 180)}, ${organizationId}, ${brandId}, ${template.id}, ${row.attributes.hook}, ${row.attributes.cta},
          ${row.attributes.presenter}, ${Math.round(row.attributes.lengthMs)}, 'review', ${row.attribute}, ${row.attributes.angle},
          ${row.attributes.format}, ${row.attributes.proof}
        )
        on conflict (id) do nothing
        returning id
      `;
      considered += 1;
      count += 1;
      if (inserted.length > 0) dailyRoom -= 1;
    }
    budget -= considered;
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
  /** The rights recorded for the variant's creatives: the two licences and the AI-label confirmation (rights.ts). */
  rights: { musicLicensed: boolean; footageLicensed: boolean; aiLabeled: boolean };
  /** A saved line can turn an unapproved claim into review. Omitted means the strict gate, which blocks it. */
  strictClaimGate?: boolean;
}): GateVerdict[] {
  return [
    originalityGate({ frameHashDistance: null, embeddingDistance: null, textSimilarity: null }),
    brandGate({ logoPresent: null, paletteMatch: null, productLooksRight: null }),
    claimsGate({ claims: recordedClaimsOf(input.storyboard ?? ""), approvedClaims: input.rules.approved, bannedWords: input.rules.banned, strict: input.strictClaimGate }),
    // This job runs no policy check, so no flag is known. Unknown is review; it is never recorded as a pass.
    policyGate({ beforeAfter: null, personalAttribute: null, healthClaim: null, financeClaim: null }),
    // The three inputs come from the records for the variant's creatives (rights.ts): the two licences and the AI-label confirmation.
    rightsGate({ musicLicensed: input.rights.musicLicensed, footageLicensed: input.rights.footageLicensed, aiLabeled: input.rights.aiLabeled }),
  ];
}

/**
 * The JEV creative_qa verdict for one variant (NORTH_STAR section 5, gate). The creative questions, the text ones and the visual ones
 * (creative.visual_quality.v1 and creative.product_visible.v1), run once, through the engine gate, when the variant's image is
 * judged at produce. That judgment writes the creative_qa gate record. This stage reads the record and does not ask the engine
 * again, so the engine is paid for once. A variant with no creative, or a creative with no recorded decision, has no evidence and is
 * review. An engine that is not configured, or whose thresholds are not calibrated, routes to review in the record, so it is never a
 * pass here.
 */
export async function creativeQaVerdict(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<GateVerdict> {
  const rows = await sql<{ creative_id: string; action: string | null }>`
    select fc.creative_id, g.action
    from factory_creatives fc
    left join lateral (
      select d.action from decision_gate_records d
      where d.organization_id = fc.organization_id and d.subject_type = 'creative' and d.subject_id = fc.creative_id
        and d.gate = 'creative_qa'
      order by d.created_at desc
      limit 1
    ) g on true
    -- A carousel is judged through its slides, which are images with their own judgment (produce-carousel.ts). Its carousel row is an
    -- aggregate, so it has no judgment of its own and is left out here; a variant whose carousel has no slides is still review.
    where fc.variant_id = ${variantId} and fc.organization_id = ${organizationId} and fc.brand_id = ${brandId}
      and not (fc.format = 'carousel' and fc.slide_index = -1)
  `;
  if (rows.length === 0) {
    return { gate: "jev", result: "review", reason: "No creative was made for this variant, so the JEV creative check has no evidence." };
  }
  if (rows.some((row) => row.action == null)) {
    return { gate: "jev", result: "review", reason: "The JEV creative check has no recorded decision for a creative of this variant." };
  }
  if (rows.some((row) => row.action === "REJECT")) {
    return { gate: "jev", result: "block", reason: "The JEV creative check rejected a creative of this variant." };
  }
  if (rows.some((row) => row.action !== "AUTO_APPROVE")) {
    return { gate: "jev", result: "review", reason: "The JEV creative check sent a creative of this variant to a person." };
  }
  return { gate: "jev", result: "pass", reason: "The JEV creative check approved every creative of this variant." };
}

/** Gates each recent variant with the rule gates and the JEV creative check, and records the combined result. */
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
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

/**
 * Gates the variants that made this creative again. Called when a licence for the creative is attested or revoked, so the stored
 * gate result follows the attestation at once and not at the next gate stage. Returns how many variants were gated.
 */
export async function regateVariantsForCreative(sql: Sql, organizationId: string, brandId: string, creativeId: string): Promise<number> {
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_creatives fc
    join factory_variants v on v.id = fc.variant_id and v.organization_id = fc.organization_id and v.brand_id = fc.brand_id
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where fc.creative_id = ${creativeId} and fc.organization_id = ${organizationId} and fc.brand_id = ${brandId}
  `;
  if (variants.length === 0) return 0;
  const rules = await brandClaimRules(sql, organizationId, brandId);
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

/** Gates one variant again, after its AI label was confirmed or revoked. Returns 1 when the variant exists in this brand, else 0. */
export async function regateVariantById(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<number> {
  const variants = await sql<{ id: string; storyboard: string | null }>`
    select v.id, t.storyboard
    from factory_variants v
    left join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where v.id = ${variantId} and v.organization_id = ${organizationId} and v.brand_id = ${brandId}
  `;
  if (variants.length === 0) return 0;
  const rules = await brandClaimRules(sql, organizationId, brandId);
  return gateVariantRows(sql, organizationId, brandId, variants, rules);
}

async function gateVariantRows(
  sql: Sql,
  organizationId: string,
  brandId: string,
  variants: Array<{ id: string; storyboard: string | null }>,
  rules: { approved: string[]; banned: string[] },
): Promise<number> {
  const line = await loadSavedFactoryPipelineConfig(sql, organizationId, brandId);
  const strictClaimGate = line?.gradingThresholds.strictClaimGate !== false;
  let count = 0;
  for (const variant of variants) {
    const jev = await creativeQaVerdict(sql, organizationId, brandId, variant.id);
    const creativeIds = await creativeIdsOfVariant(sql, organizationId, brandId, variant.id);
    const licences = await licencesForCreatives(sql, organizationId, brandId, creativeIds);
    const rights = variantLicenceFlags(creativeIds, licences);
    const combined = combineGates([...variantGateVerdicts({ storyboard: variant.storyboard, rules, rights, strictClaimGate }), jev]);
    await sql`
      update factory_variants set gate_result = ${combined.result}
      where id = ${variant.id} and organization_id = ${organizationId} and brand_id = ${brandId}
    `;
    count += 1;
  }
  return count;
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
