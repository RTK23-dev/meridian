/**
 * The sleep night (NORTH_STAR section 5; Bible 16 and 11.3). Once a night the scheduler runs runSleepNight for the workspace.
 *
 * The night gathers, grades and plans, through the same stage functions the Factory runs (executeFactoryJob): discover, ingest,
 * decode, grade, trend, pick and template. It never runs produce, gate, review, launch or test. The run it creates waits at produce
 * for a person's approval, through the existing approval gate, so nothing is produced or published on the night's own authority.
 *
 * Every planned item is assigned to the holdout or to the treated arm by a hash of its id, and each assignment is stored
 * (factory_holdouts). Produce skips a holdout item and makes the treated ones. The night's morning summary (sleep_mode_nights) says what ran, the counts, the holdout ids, the failures and
 * why the night stopped, if it did, and each tuned-value change it refused under the nightly change cap (sleep-tuning.ts). A night with no budget, no connected source or the kill switch engaged records why and stops.
 *
 * A night that fails is retried by its job. The retry continues the night's run and does not run the stages an earlier attempt
 * finished. A night that reached its end (planned or stopped) is never run again.
 */
import { thresholds } from "../../../engine/config/thresholds.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { adsMustPause } from "./kill-switch.ts";
import type { FactoryStage } from "./pipeline.ts";
import { brandCapFiguresOf, capOrNull } from "./spend.ts";
import { capStopReason } from "./stage-decision.ts";
import { runSettingsFromStorage, type RunSettings } from "./run-settings.ts";
import { challengerArmOf, holdoutArmOf } from "./sleep-holdout.ts";
import { localDateKey, nextNightAt, SLEEP_JOB_TYPE, sleepScheduleIdOf } from "./sleep-time.ts";
import { nightlyTuningOf, tuningSummaryOf, type TunedProposal } from "./sleep-tuning.ts";
import { executeFactoryJob } from "./worker.ts";

/** The stages a night runs, in order. Nothing after template runs here: production waits for a person's approval. */
export const SLEEP_STAGES: readonly FactoryStage[] = [
  "factory.discover",
  "factory.ingest",
  "factory.decode",
  "factory.grade",
  "factory.trend",
  "factory.pick",
  "factory.template",
];

/**
 * The prompt versions a challenger may use. The engine owns its prompt registry (src/engine/prompts), and it is not exposed to
 * Meridian, so the list is empty. A night therefore records that no challenger ran, rather than inventing a version.
 */
export const CHALLENGER_PROMPT_VERSIONS: readonly string[] = [];

/** The longest stage result or failure kept in the night record. */
const RESULT_CHARS = 300;

type SleepSettingsRow = {
  enabled: boolean;
  brand_id: string | null;
  night_time: string;
  time_zone: string;
  niche: string;
  updated_by: string;
};

export type NightSource = { source: string; state: string; reason: string; items: number };
type StageRecord = { stage: string; result: string };
type NightEnd = "planned" | "stopped" | "failed";

async function killSwitchEngaged(sql: Sql, organizationId: string, brandId: string): Promise<boolean> {
  const rows = await sql<{ scope: string; engaged: boolean }>`
    select scope, engaged from factory_kill_switches
    where organization_id = ${organizationId} and (brand_id is null or brand_id = ${brandId})
  `;
  return adsMustPause({
    workspaceEngaged: rows.some((row) => row.scope === "workspace" && row.engaged),
    brandEngaged: rows.some((row) => row.scope === "brand" && row.engaged),
  });
}

async function sourcesOfRun(sql: Sql, organizationId: string, brandId: string, runId: string): Promise<NightSource[]> {
  const rows = await sql<{ source: string; state: string; reason: string; items: number }>`
    select source, state, reason, items from factory_run_sources
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
    order by created_at asc, source asc
  `;
  return rows.map((row) => ({ source: row.source, state: row.state, reason: row.reason, items: Number(row.items) }));
}

/** A night an earlier attempt began and did not finish. This attempt continues its run and keeps the stages it finished. */
type ResumedNight = { nightId: string; runId: string; finished: StageRecord[] };

/** The stages an earlier attempt finished, read from the night's record. A stage that failed is not finished, so it runs again. */
function finishedStagesOf(text: string): StageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const finished: StageRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { stage, result } = entry as { stage?: unknown; result?: unknown };
    if (typeof stage !== "string" || typeof result !== "string") continue;
    if (!SLEEP_STAGES.includes(stage as FactoryStage) || result.startsWith("failed:")) continue;
    finished.push({ stage, result });
  }
  return finished;
}

/** Whether another sleep job of the workspace holds a live lease, so it may be running a night now. */
async function otherSleepJobLive(sql: Sql, organizationId: string, jobId: string): Promise<boolean> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from jobs
    where organization_id = ${organizationId} and job_type = ${SLEEP_JOB_TYPE} and status = 'running'
      and lease_until > now() and id <> ${jobId}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Claims a night an earlier attempt began, so this attempt can finish it. A failed night is claimed. A night still marked running is
 * claimed only when no other sleep job of the workspace holds a live lease: the queue runs one attempt of a job at a time, so that
 * night was left by a worker that died. Returns null when the night reached its end, or another attempt is running it.
 *
 * The check and the claim run in one transaction under a lock on the night's row, so two attempts cannot both claim one night.
 */
async function claimEarlierNight(sql: Sql, organizationId: string, nightKey: string, jobId: string): Promise<ResumedNight | null> {
  const earlier = await sql<{ status: string }>`
    select status from sleep_mode_nights where organization_id = ${organizationId} and night_key = ${nightKey} limit 1
  `;
  if (earlier[0]?.status !== "failed" && earlier[0]?.status !== "running") return null;

  return withTransaction(sql, async (tx) => {
    const rows = await tx<{ id: string; status: string; run_id: string; stages: string }>`
      select id, status, run_id, stages from sleep_mode_nights
      where organization_id = ${organizationId} and night_key = ${nightKey}
      for update
    `;
    const night = rows[0];
    if (!night) return null;
    if (night.status === "running" && (await otherSleepJobLive(tx, organizationId, jobId))) return null;
    if (night.status !== "failed" && night.status !== "running") return null;
    await tx`
      update sleep_mode_nights set status = 'running', reason = '', finished_at = null
      where id = ${night.id} and organization_id = ${organizationId}
    `;
    return { nightId: night.id, runId: night.run_id, finished: finishedStagesOf(night.stages) };
  });
}

/** Records the stages finished so far, so an attempt that fails before the night ends does not run them again. */
async function saveStageProgress(sql: Sql, organizationId: string, nightId: string, stages: StageRecord[]): Promise<void> {
  await sql`
    update sleep_mode_nights set stages = ${JSON.stringify(stages)}
    where id = ${nightId} and organization_id = ${organizationId}
  `;
}

/**
 * One stage, run through the factory's own stage function with a job built for it. A stage that throws is recorded as a failure,
 * and the night stops there. Returns the stage's result, or null when it failed.
 */
async function runStage(
  sql: Sql,
  input: { organizationId: string; brandId: string; runId: string; niche: string; nightId: string },
  stage: FactoryStage,
  stages: StageRecord[],
  failures: string[],
  execute: StageRunner = executeFactoryJob,
): Promise<string | null> {
  const payload = { organizationId: input.organizationId, brandId: input.brandId, runId: input.runId, niche: input.niche, stage };
  const job: ExecutableJob = {
    id: `${input.nightId}:${stage}`,
    organization_id: input.organizationId,
    brand_id: input.brandId,
    job_type: stage,
    payload: JSON.stringify(payload),
    attempts: 1,
    max_attempts: 1,
  };
  try {
    const result = await execute(sql, job, payload);
    stages.push({ stage, result: result.slice(0, RESULT_CHARS) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${stage}: ${message}`.slice(0, RESULT_CHARS));
    stages.push({ stage, result: `failed: ${message}`.slice(0, RESULT_CHARS) });
    return null;
  }
}

/**
 * What a night is given beyond the database. `tuning` is the tuned values the night proposes to move, each with its current value and
 * bounds. Every proposal is held to the nightly change cap (sleep-tuning.ts), and the morning summary records each refusal. Production
 * passes none: sleep mode proposes no tuned value in this build, so the night records that the cap was not used.
 */
export type SleepSeams = {
  tuning?: readonly TunedProposal[];
  /** Runs one factory stage. Unset, the night runs the factory's own stage function. Tests pass a stand-in. */
  stage?: StageRunner;
};

type StageRunner = (sql: Sql, job: ExecutableJob, payload: Record<string, unknown>) => Promise<string>;

/**
 * Runs one night for the workspace. The job returns a short result ("sleep:planned", "sleep:stopped", "sleep:failed", or
 * "sleep:off" when sleep mode is off). A database failure before the night row exists throws, so the job is retried.
 */
export async function runSleepNight(sql: Sql, job: ExecutableJob, now: Date = new Date(), seams: SleepSeams = {}): Promise<string> {
  const organizationId = job.organization_id;
  const settingsRows = await sql<SleepSettingsRow>`
    select enabled, brand_id, night_time, time_zone, niche, updated_by from sleep_mode_settings
    where organization_id = ${organizationId}
    limit 1
  `;
  const settings = settingsRows[0];
  if (!settings || !settings.enabled || !settings.brand_id) return "sleep:off";
  if (settings.brand_id !== job.brand_id) return "sleep:brand-changed";
  const brandId = settings.brand_id;

  // The schedule moves to the next local night time from now, so daylight saving does not shift the night.
  await sql`
    update job_schedules set next_run = ${nextNightAt(now, settings.night_time, settings.time_zone).toISOString()}
    where id = ${sleepScheduleIdOf(organizationId)} and organization_id = ${organizationId} and enabled = true
  `;

  // A night is keyed by its local date, so it runs once: a night that reached its end is not run again. A night an earlier attempt
  // failed to finish is claimed and resumed here (claimEarlierNight), so the retry of a failed night runs it.
  const nightKey = localDateKey(now, settings.time_zone);
  const newNightId = crypto.randomUUID();
  const created = await sql<{ id: string }>`
    insert into sleep_mode_nights (id, organization_id, brand_id, night_key, status, started_at)
    values (${newNightId}, ${organizationId}, ${brandId}, ${nightKey}, 'running', now())
    on conflict (organization_id, night_key) do nothing
    returning id
  `;
  const resumed = created[0] ? null : await claimEarlierNight(sql, organizationId, nightKey, job.id);
  if (!created[0] && !resumed) return `sleep:already-ran:${nightKey}`;
  const nightId = resumed?.nightId ?? newNightId;

  try {
    const end = await runNight(sql, {
      organizationId,
      brandId,
      nightId,
      nightKey,
      niche: settings.niche.trim(),
      updatedBy: settings.updated_by,
      timeZone: settings.time_zone,
      tuningProposals: seams.tuning ?? [],
      stageRunner: seams.stage,
      resumed,
    });
    return `sleep:${end}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The night and its run both record the failure, so neither shows as running. The job queue retries the job, and the retry resumes
    // this night from the stages it did not finish.
    await sql`
      update sleep_mode_nights set status = 'failed', reason = ${message.slice(0, 400)}, finished_at = now()
      where id = ${nightId} and organization_id = ${organizationId}
    `;
    await sql`
      update factory_runs set status = 'failed', error = ${`Sleep mode stopped: ${message}`.slice(0, 500)}, updated_at = now()
      where organization_id = ${organizationId} and status in ('queued', 'running')
        and id in (
          select run_id from sleep_mode_nights
          where id = ${nightId} and organization_id = ${organizationId} and run_id <> ''
        )
    `;
    throw error;
  }
}

async function runNight(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    nightId: string;
    nightKey: string;
    niche: string;
    updatedBy: string;
    timeZone: string;
    tuningProposals: readonly TunedProposal[];
    stageRunner?: StageRunner;
    resumed: ResumedNight | null;
  },
): Promise<NightEnd> {
  const { organizationId, brandId, nightId, nightKey, niche } = input;
  // The stages an earlier attempt finished stand as they were. The stages after them run now.
  const stages: StageRecord[] = [...(input.resumed?.finished ?? [])];
  const finished = new Map(stages.map((record): [string, string] => [record.stage, record.result]));
  const failures: string[] = [];
  const sources: NightSource[] = [];
  const holdoutIds: string[] = [];
  const counts: Record<string, number> = {};
  let runId = "";
  // Every proposed tuned change is held to the nightly cap, whatever the night's own outcome, so the morning summary always says what was
  // refused. Nothing is written to engine config here: an accepted change is recorded in change_budget only.
  const tuning = nightlyTuningOf(input.tuningProposals);
  const tuningNote =
    input.tuningProposals.length === 0
      ? "No tuned value was proposed tonight, so the nightly change cap was not used."
      : "Each proposed change was held to the nightly cap. A change beyond it was refused for the excess, and the morning summary gives the reason. Sleep mode writes no engine config: an accepted change is recorded here only.";

  const conclude = async (outcome: { end: NightEnd; reason: string; summary: string; runStatus: string | null; runError: string; runStage: string }) => {
    if (outcome.runStatus !== null && runId) {
      await sql`
        update factory_runs set status = ${outcome.runStatus}, current_stage = ${outcome.runStage}, error = ${outcome.runError}, updated_at = now()
        where id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
      `;
    }
    const challengerDecision = challengerArmOf(`night:${nightKey}`, thresholds.claude.challengerShare.value, CHALLENGER_PROMPT_VERSIONS);
    const morningSummary = [outcome.summary, tuningSummaryOf(tuning)].filter((part) => part !== "").join(" ");
    await sql`
      update sleep_mode_nights set
        status = ${outcome.end}, run_id = ${runId}, reason = ${outcome.reason.slice(0, 400)}, summary = ${morningSummary},
        sources = ${JSON.stringify(sources)}, stages = ${JSON.stringify(stages)}, counts = ${JSON.stringify(counts)},
        holdout_item_ids = ${JSON.stringify(holdoutIds)}, failures = ${JSON.stringify(failures)},
        challenger = ${JSON.stringify({ share: thresholds.claude.challengerShare.value, versions: CHALLENGER_PROMPT_VERSIONS, decision: challengerDecision })},
        change_budget = ${JSON.stringify({
          maxNightlyChangeShare: tuning.maxChangeShare,
          tunedValuesAccepted: tuning.accepted.length,
          tunedValuesRefused: tuning.refused.length,
          accepted: tuning.accepted,
          refused: tuning.refused,
          note: tuningNote,
        })},
        finished_at = now()
      where id = ${nightId} and organization_id = ${organizationId}
    `;
    return outcome.end;
  };

  // The kill switch stops every stage, so the night does not start.
  if (await killSwitchEngaged(sql, organizationId, brandId)) {
    return conclude({ end: "stopped", reason: "The kill switch is engaged. Nothing runs until it is released.", summary: "Stopped: the kill switch is engaged.", runStatus: null, runError: "", runStage: "" });
  }

  // The budget. A night with no cap set does nothing, and says so. Each scope is checked on its own, the way the stage check checks it
  // (capStopReason): the run's default caps against the run's own spend, and the brand's caps against the brand's spend across all its
  // runs. A new run starts at zero, so the run's caps are not reached at the start; the stage checks hold them as the run spends. The
  // scopes are not merged, because a merged cap compares one scope's spend with another scope's cap and names the wrong scope. The first
  // scope reached stops the night, and the reason names it.
  const brandRows = await sql<{ run_defaults: string }>`
    select run_defaults from brands where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null limit 1
  `;
  const defaults: RunSettings = runSettingsFromStorage(brandRows[0]?.run_defaults, 0);
  const runTotalCap = capOrNull(defaults.caps.totalCents);
  const runDailyCap = capOrNull(defaults.caps.dailyCents);
  const brand = await brandCapFiguresOf(sql, organizationId, brandId);
  const anyCapSet = [runTotalCap, runDailyCap, capOrNull(brand.brandCapCents), capOrNull(brand.brandDailyCapCents)].some((cap) => cap !== null);
  if (!anyCapSet) {
    return conclude({
      end: "stopped",
      reason: "No spend cap is set for this brand, so sleep mode did not run. Set a cap in the Factory, and the night will run within it.",
      summary: "Stopped: no spend cap is set.",
      runStatus: null,
      runError: "",
      runStage: "",
    });
  }
  const reached = capStopReason({
    capCents: runTotalCap,
    spentCents: 0,
    dailyCapCents: runDailyCap,
    dailySpentCents: 0,
    ...brand,
  });
  if (reached) {
    return conclude({ end: "stopped", reason: reached, summary: `Stopped: ${reached}`, runStatus: null, runError: "", runStage: "" });
  }

  if (!niche) {
    return conclude({
      end: "stopped",
      reason: "No niche is set for sleep mode, so there is nothing to gather. Set the niche, and the night will run.",
      summary: "Stopped: no niche is set.",
      runStatus: null,
      runError: "",
      runStage: "",
    });
  }

  // The run the night works in. A resumed night continues the run an earlier attempt began, so the candidates that run stored are kept.
  // A new run starts with the brand's run defaults, and it is the same kind of run the Factory starts.
  if (input.resumed?.runId) {
    runId = input.resumed.runId;
    const continued = await sql<{ id: string }>`
      update factory_runs set status = 'running', error = '', updated_at = now()
      where id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
        and status in ('failed', 'paused', 'running')
      returning id
    `;
    if (!continued[0]) {
      return conclude({
        end: "stopped",
        reason: "The run this night began cannot be continued, so the night did not run again. The run shows its status.",
        summary: "Stopped: the run this night began cannot be continued.",
        runStatus: null,
        runError: "",
        runStage: "",
      });
    }
  } else {
    const levelRows = await sql<{ level: number }>`
      select level from factory_settings where organization_id = ${organizationId} and brand_id = ${brandId} limit 1
    `;
    runId = crypto.randomUUID();
    await sql`
      insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by, settings)
      values (${runId}, ${organizationId}, ${brandId}, ${niche}, ${Number(levelRows[0]?.level ?? 0)}, 'running', 'factory.discover',
        ${input.updatedBy}, ${JSON.stringify(defaults)})
    `;
    await sql`update sleep_mode_nights set run_id = ${runId} where id = ${nightId} and organization_id = ${organizationId}`;
  }

  const stageInput = { organizationId, brandId, runId, niche, nightId };
  let haltReason = "";
  let lastStage: FactoryStage = "factory.discover";
  for (const stage of SLEEP_STAGES) {
    lastStage = stage;
    // A stage an earlier attempt finished is not run again. Its result stands, and the checks below still apply to it.
    const earlier = finished.get(stage);
    const result = earlier ?? (await runStage(sql, stageInput, stage, stages, failures, input.stageRunner));
    if (result === null) break;
    if (earlier === undefined) await saveStageProgress(sql, organizationId, nightId, stages);
    // A stage that the run's own rules stopped (the kill switch, a cap, a waiting approval) ends the night at that stage.
    if (result.startsWith("stopped:") || result.startsWith("awaiting-approval:")) {
      haltReason = `The run stopped at ${stage}, so the night stopped with it. The run shows the reason.`;
      break;
    }
    if (stage === "factory.discover") {
      const read = await sourcesOfRun(sql, organizationId, brandId, runId);
      sources.splice(0, sources.length, ...read);
      if (!read.some((row) => row.state === "ok")) {
        const states = read.map((row) => `${row.source}: ${row.state}`).join("; ") || "no source reported";
        haltReason = `No source is connected for this niche, so the night had nothing to grade. ${states}.`;
        break;
      }
    }
  }
  counts.sourcesOk = sources.filter((row) => row.state === "ok").length;
  counts.sourcesNotConnected = sources.filter((row) => row.state === "not_connected").length;
  counts.sourcesFailed = sources.filter((row) => row.state === "failed").length;

  const pickRows = await sql<{ n: number }>`
    select count(*)::int as n from factory_picks where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
  `;
  const picks = Number(pickRows[0]?.n ?? 0);
  const templateRows = await sql<{ id: string }>`
    select id from factory_templates
    where organization_id = ${organizationId} and brand_id = ${brandId} and id like ${`tpl:${runId}:%`} and plan <> ''
    order by id asc
  `;
  const planned = templateRows.map((row) => row.id);
  counts.picks = picks;
  counts.planned = planned.length;

  if (failures.length > 0) {
    const first = failures[0] ?? "A stage failed.";
    return conclude({
      end: "failed",
      reason: first,
      summary: `Failed: ${first}`,
      runStatus: "paused",
      runError: `Sleep mode stopped: ${first}`,
      runStage: stages[stages.length - 1]?.stage ?? "factory.discover",
    });
  }
  if (haltReason) {
    return conclude({ end: "stopped", reason: haltReason, summary: `Stopped: ${haltReason}`, runStatus: "paused", runError: haltReason, runStage: lastStage });
  }
  if (planned.length === 0) {
    const why = picks === 0
      ? "No concept was picked tonight, so nothing was planned."
      : "The picked concepts have no engine decision to plan from, so nothing was planned.";
    return conclude({ end: "stopped", reason: why, summary: `Stopped: ${why}`, runStatus: "paused", runError: why, runStage: "factory.template" });
  }

  // The holdout: each planned item gets one arm, by a hash of its id, and every assignment is recorded for the learning step.
  const holdoutShare = thresholds.learning.holdoutShare;
  counts.holdoutShare = holdoutShare;
  let treated = 0;
  for (const itemId of planned) {
    const arm = holdoutArmOf(itemId, holdoutShare);
    if (arm === "holdout") holdoutIds.push(itemId);
    else treated += 1;
    await sql`
      insert into factory_holdouts (id, organization_id, brand_id, night_id, run_id, item_id, arm, share)
      values (${crypto.randomUUID()}, ${organizationId}, ${brandId}, ${nightId}, ${runId}, ${itemId}, ${arm}, ${holdoutShare})
      on conflict (organization_id, item_id) do nothing
    `;
  }
  counts.holdout = holdoutIds.length;
  counts.treated = treated;

  const waitText = `Sleep mode planned ${planned.length} item(s) and stopped before production. A person approves produce to continue.`;
  const summary = [
    `Gathered: ${counts.sourcesOk} source(s) ok, ${counts.sourcesNotConnected} not connected, ${counts.sourcesFailed} failed.`,
    `Picked ${picks}, planned ${planned.length}.`,
    `Holdout: ${holdoutIds.length} item(s) assigned to the holdout. Production does not make those items. The treated items wait for a person to approve produce.`,
    waitText,
  ].join(" ");
  return conclude({
    end: "planned",
    reason: waitText,
    summary,
    runStatus: "awaiting_approval",
    runError: waitText,
    runStage: "factory.produce",
  });
}
