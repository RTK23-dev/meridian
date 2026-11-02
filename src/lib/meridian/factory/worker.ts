import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { defaultGatherDeps, gatherForRun, gatheredSummary, type GatherDeps } from "./gather.ts";
import { CREATIVE_DNA_VERSION, dnaFromTranscript, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { decodeVideoDna } from "./decode.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { isFactoryStage } from "./pipeline.ts";
import { clearLearnRecheck, learnForRun, scheduleLearnRecheck } from "./learn.ts";
import { loadSavedFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { runSettingsFromStorage } from "./run-settings.ts";
import { queueStagesFrom } from "./queue-stages.ts";
import { stageDecision } from "./stage-decision.ts";
import { brandCapFiguresOf, capOrNull, capStopForRun, meteredSpendOf, pauseRunEngineSpend } from "./spend.ts";
import { produceFactoryCreatives, scheduleProduceRecheck } from "./produce.ts";
import type { FactoryEngineSeams } from "./produce-shared.ts";
import { launchFactoryRun, recordTestPlan, scheduleRunMeasurement } from "./publish.ts";
import { snapshotMediaAllowed } from "./sources.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import { learningScopesOf, pickConceptsForRun } from "./pick.ts";
import { text, killSwitchPaused } from "./worker-shared.ts";
import { gradeStoredAds } from "./worker-grade.ts";
import { savedPlanLine, persistTemplates, persistVariants } from "./worker-variants.ts";
import { gateVariants } from "./worker-gate.ts";
export { variantGateVerdicts, creativeQaVerdict, regateVariantsForCreative, regateVariantById } from "./worker-gate.ts";

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

function guessFormat(source: string): AdFormat {
  const text = source.toLowerCase();
  if (text.includes("unbox")) return "unboxing";
  if (text.includes("testimonial") || text.includes("review")) return "testimonial";
  if (text.includes("how to") || text.includes("demo")) return "demo";
  if (text.includes("skit")) return "skit";
  return "other";
}
