/**
 * The sleep night (NORTH_STAR section 5; Bible 16 and 11.3). Once a night the scheduler runs runSleepNight for the workspace.
 *
 * The night gathers, grades and plans, through the same stage functions the Factory runs (executeFactoryJob): discover, ingest,
 * decode, grade, trend, pick and template. It never runs produce, gate, review, launch or test. The run it creates waits at produce
 * for a person's approval, through the existing approval gate, so nothing is produced or published on the night's own authority.
 *
 * Every planned item is assigned to the holdout or to the treated arm by a hash of its id, and each assignment is stored
 * (factory_holdouts). The night's morning summary (sleep_mode_nights) says what ran, the counts, the holdout ids, the failures and
 * why the night stopped, if it did, and each tuned-value change it refused under the nightly change cap (sleep-tuning.ts). A night with no budget, no connected source or the kill switch engaged records why and stops.
 */
import { thresholds } from "../../../engine/config/thresholds.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";
import { adsMustPause } from "./kill-switch.ts";
import type { FactoryStage } from "./pipeline.ts";
import { effectiveCap, spendCapsOf } from "./spend.ts";
import { capStopReason } from "./stage-decision.ts";
import { runSettingsFromStorage, type RunSettings } from "./run-settings.ts";
import { challengerArmOf, holdoutArmOf } from "./sleep-holdout.ts";
import { localDateKey, nextNightAt, sleepScheduleIdOf } from "./sleep-time.ts";
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

/** The brand's cost of one day of metered spend, in cents. The same rule as meteredSpendOf: a provider cost counts in cents. */
async function brandDailySpendCents(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rows = await sql<{ total: number }>`
    select coalesce(sum(coalesce(micros, cents::bigint * 10000)), 0)::float8 as total
    from factory_costs
    where organization_id = ${organizationId} and brand_id = ${brandId} and created_at >= now() - interval '1 day'
  `;
  // 10,000 micros make one cent (MICROS_PER_CENT in spend.ts). A total is rounded up so a cap is never under-counted.
  return Math.ceil(Number(rows[0]?.total ?? 0) / 10_000);
}

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
    const result = await executeFactoryJob(sql, job, payload);
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
export type SleepSeams = { tuning?: readonly TunedProposal[] };

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

  // A night is keyed by its local date, so it runs once. A night left running by an earlier attempt is marked failed.
  const nightKey = localDateKey(now, settings.time_zone);
  const nightId = crypto.randomUUID();
  const created = await sql<{ id: string }>`
    insert into sleep_mode_nights (id, organization_id, brand_id, night_key, status, started_at)
    values (${nightId}, ${organizationId}, ${brandId}, ${nightKey}, 'running', now())
    on conflict (organization_id, night_key) do nothing
    returning id
  `;
  if (!created[0]) {
    await sql`
      update sleep_mode_nights
      set status = 'failed', reason = ${"The night stopped before it finished, and it was not run again."}, finished_at = now()
      where organization_id = ${organizationId} and night_key = ${nightKey} and status = 'running'
    `;
    return `sleep:already-ran:${nightKey}`;
  }

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
    });
    return `sleep:${end}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update sleep_mode_nights set status = 'failed', reason = ${message.slice(0, 400)}, finished_at = now()
      where id = ${nightId} and organization_id = ${organizationId}
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
  },
): Promise<NightEnd> {
  const { organizationId, brandId, nightId, nightKey, niche } = input;
  const stages: StageRecord[] = [];
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

  // The budget. A night with no cap set does nothing, and says so. The total cap applies per run, and a new run starts at zero.
  const caps = await spendCapsOf(sql, organizationId, brandId);
  const brandRows = await sql<{ run_defaults: string }>`
    select run_defaults from brands where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null limit 1
  `;
  const defaults: RunSettings = runSettingsFromStorage(brandRows[0]?.run_defaults, 0);
  const totalCap = effectiveCap(defaults.caps.totalCents, caps.totalCents);
  const dailyCap = effectiveCap(defaults.caps.dailyCents, caps.dailyCents);
  if (totalCap === null && dailyCap === null) {
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
    capCents: totalCap,
    spentCents: 0,
    dailyCapCents: dailyCap,
    dailySpentCents: await brandDailySpendCents(sql, organizationId, brandId),
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

  // The run the night works in. It starts with the brand's run defaults, and it is the same kind of run the Factory starts.
  const levelRows = await sql<{ level: number }>`
    select level from factory_settings where organization_id = ${organizationId} and brand_id = ${brandId} limit 1
  `;
  runId = crypto.randomUUID();
  await sql`
    insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by, settings)
    values (${runId}, ${organizationId}, ${brandId}, ${niche}, ${Number(levelRows[0]?.level ?? 0)}, 'running', 'factory.discover',
      ${input.updatedBy}, ${JSON.stringify(defaults)})
  `;

  const stageInput = { organizationId, brandId, runId, niche, nightId };
  let haltReason = "";
  let lastStage: FactoryStage = "factory.discover";
  for (const stage of SLEEP_STAGES) {
    lastStage = stage;
    const result = await runStage(sql, stageInput, stage, stages, failures);
    if (result === null) break;
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
    `Holdout: ${holdoutIds.length} item(s) assigned to the holdout and recorded for the learning step. Production does not read the holdout yet.`,
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
