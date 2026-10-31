// Grading the stored ads of a factory run: the grade call, its caps and the stored grades. Moved out of factory/worker.ts
// unchanged (coding loop, T5). worker.ts keeps its public names.

import type { Sql } from "../learning/store.ts";
import { CREATIVE_DNA_VERSION, type CreativeDna } from "./creative-dna.ts";
import { recordDecisionSpend } from "./decision-spend.ts";
import { KILL_SWITCH_STOP_REASON } from "./stage-decision.ts";
import { capStopForRun } from "./spend.ts";
import { predictionFingerprint, type GradeRecord } from "./prediction.ts";
import { buildAdTimeline } from "./timeline.ts";
import { deliveryFactsOf } from "../research/store.ts";
import { winnerScore } from "./winner-score.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";
import { loadFactoryBrain } from "./brain-facts.ts";
import { cappedGradeReason, gradeColumnsOf, gradeItemWithEngine, NO_DNA_GRADE, NO_ENGINE_GRADE, observedOnlyGrade, resolveGradeEngine, type GradeColumns, type GradeEngine, type GradeEngineChoice, type GradeItem } from "./grade.ts";
import { text, parseList, killSwitchPaused } from "./worker-shared.ts";

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

export async function gradeStoredAds(
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
