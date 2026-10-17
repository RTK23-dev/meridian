/**
 * The Pick stage (NORTH_STAR section 5, pick): choose what to make next from the graded concepts.
 *
 * A concept is one creative angle, with its format and hook type, read from the creative DNA of the graded ads. A pick
 * - is filtered out when the brand's own brain rules the concept out: the brain is too thin to confirm fit, or the concept's words
 *   include one the brand avoids;
 * - is weighted by what the brand has learned on each surface the run makes creatives for (organic, paid, or both), from its learned
 *   patterns (learning/engine.ts). Each surface's patterns weight only that surface's arm of a concept, never the other's;
 * - gets one Thompson draw from its delivery record (thompson.ts). A concept with proven delivery and one with none both have a
 *   chance, so the run balances proven angles against untested ones. The seed is the run id, so a run's picks can be reproduced.
 *
 * A run with intent both has an organic arm and a paid arm for each concept. The concept is picked once, on the arm whose draw ranks
 * first, and the pick records that surface. Each pick records the JEV grade fingerprint its ad carried (prediction.ts).
 *
 * The weights are ranking weights. They are not measured lifts, and they are uncalibrated. Every pick is stored with its method.
 */

import type { Sql } from "../learning/store.ts";
import { learningDirection, patternInfluence } from "../learning/engine.ts";
import type { LearnedPattern, LearningSurface } from "../domain.ts";
import { brandFitQuestion } from "../jev/questions.ts";
import type { BrainKey } from "../brain.ts";
import { CREATIVE_DNA_VERSION, type CreativeDna } from "./creative-dna.ts";
import { linesOf, loadFactoryBrain } from "./brain-facts.ts";
import { loadSavedFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { thompsonRank, type ThompsonArm } from "./thompson.ts";
import type { Intent } from "./run-settings.ts";
import { predictionFingerprint, type GradeRecord } from "./prediction.ts";

export type SurfaceProposal = {
  concept: string;
  fromSurface: LearningSurface;
  toSurface: LearningSurface;
  attribute: string;
  value: string;
  reason: string;
};

/**
 * A positive learned pattern on one surface, proposed as a test on the other. A pattern that is already positive on the other surface
 * is not proposed again. The proposal is a record only: it does not change either surface's weight.
 */
export function crossSurfaceProposals(
  concept: { label: string; angle: string; hookType: string; format: string },
  patterns: ReadonlyArray<{
    attribute: string;
    value: string;
    surface: string;
    lift: number;
    sampleSize: number;
    impressions: number;
    pBeat?: number;
    ciLow?: number;
    ciHigh?: number;
  }>,
): SurfaceProposal[] {
  const own: Record<string, string> = {
    angle: concept.angle,
    hook: concept.hookType,
    hook_type: concept.hookType,
    format: concept.format,
  };
  const wins = patterns.filter(
    (row) =>
      (row.surface === "organic" || row.surface === "paid")
      && learningDirection({
        lift: row.lift,
        sampleSize: row.sampleSize,
        impressions: row.impressions,
        pBeat: row.pBeat,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
      }) === "POSITIVE",
  );
  const proposals: SurfaceProposal[] = [];
  const seen = new Set<string>();
  for (const row of wins) {
    const owned = own[row.attribute];
    if (!owned || owned.trim().toLowerCase() !== row.value.trim().toLowerCase()) continue;
    const toSurface: LearningSurface = row.surface === "organic" ? "paid" : "organic";
    const alreadyThere = wins.some(
      (other) =>
        other.surface === toSurface
        && other.attribute === row.attribute
        && other.value.trim().toLowerCase() === row.value.trim().toLowerCase(),
    );
    if (alreadyThere) continue;
    const key = `${row.surface}|${toSurface}|${row.attribute}|${row.value.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push({
      concept: concept.label,
      fromSurface: row.surface as LearningSurface,
      toSurface,
      attribute: row.attribute,
      value: row.value,
      reason: `${row.attribute} ${row.value} won on ${row.surface}. It is proposed as a ${toSurface} test. The ${toSurface} weight is not changed.`,
    });
  }
  return proposals;
}

/** A saved winner-score floor excludes a lower score. No saved line means every scored concept can be picked. */
export function winnerClearsFloor(score: number, floor: number | null): boolean {
  return floor === null || score >= floor;
}

/** A saved confidence floor excludes a decoded trait that is less sure. A trait with no confidence is still used. */
export function confidenceClearsFloor(confidence: number | null, floor: number | null): boolean {
  return floor === null || confidence === null || confidence >= floor;
}
/** A saved P(beat) floor excludes a pattern that measured a lower probability. A pattern with no probability is still used. */
export function patternClearsBeatFloor(pBeat: number | null, floor: number | null): boolean {
  return floor === null || pBeat === null || pBeat >= floor;
}

/** A 3 s retention floor ignores only a retention_3s pattern whose measured rate is lower. Other metrics are not compared to it. A missing rate is still used. */
export function retentionClearsFloor(metric: string, observed: number | null, floor: number | null): boolean {
  if (floor === null || metric !== "retention_3s" || observed === null || !Number.isFinite(observed)) return true;
  return observed >= floor;
}

export const LEARNED_WEIGHT_SCALE = 0.5;

/** The lowest weight a learned pattern can give. A concept the brand learned to lose on is still possible, and rarely picked. */
const MIN_LEARNED_WEIGHT = 0.1;

export type Concept = {
  /** The grouping key: format, hook type and angle, lowercased. */
  key: string;
  /** The label a reader sees, for example "demo / question hook / problem-solution". */
  label: string;
  angle: string;
  hookType: string;
  format: string;
};

/** The concept a creative DNA belongs to, or null when the DNA names no angle, because a concept needs one. */
export function conceptOf(dna: CreativeDna): Concept | null {
  const angle = dna.angle.value.trim();
  if (!angle) return null;
  const hookType = dna.hook.type.value.trim();
  const format = dna.format.value.trim();
  const parts = [format && format !== "other" ? format : "", hookType ? `${hookType} hook` : "", angle].filter(Boolean);
  return {
    key: [format, hookType, angle].map((part) => part.toLowerCase()).join("|"),
    label: parts.join(" / "),
    angle,
    hookType,
    format,
  };
}

/** The words of a concept that a brand text can match: at least three letters, lowercased, without repeats. */
function wordsOf(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 3))];
}

export type BrandFitReading = { passes: boolean; probability: number | null; reason: string };

/**
 * Whether the brand's brain allows the concept. The lexical fit comes from the brand-fit question, which is not a model grade. The
 * concept is filtered out when that question has no evidence (the brain is too thin to confirm fit), or when its words include one the
 * brand avoids.
 */
export function brandFitOf(concept: Concept, brain: Record<BrainKey, string>, completeness: number): BrandFitReading {
  const words = wordsOf(`${concept.angle} ${concept.hookType} ${concept.format}`);
  const brandText = [brain.positioning, brain.valueProposition, brain.targetCustomers, brain.differentiators, brain.tone, brain.offers, brain.problems]
    .join(" ")
    .toLowerCase();
  const hits = words.filter((word) => brandText.includes(word)).length;
  const preferred = linesOf(brain.preferredFormats).join(" ").toLowerCase();
  const reading = brandFitQuestion.evaluate({
    keywordHits: hits,
    keywordTotal: words.length,
    formatPreferred: concept.format !== "" && preferred.includes(concept.format.toLowerCase()),
    brainFilled: completeness,
  });
  if (reading.evidenceState === "missing") {
    return { passes: false, probability: null, reason: reading.reasons[0] ?? "The brand brain is too thin to confirm fit." };
  }
  const label = concept.label.toLowerCase();
  const avoided = linesOf(brain.wordsToAvoid).filter((word) => label.includes(word.toLowerCase()));
  if (avoided.length > 0) {
    return { passes: false, probability: reading.probability, reason: `The concept uses words the brand avoids: ${avoided.join(", ")}.` };
  }
  return { passes: true, probability: reading.probability, reason: reading.reasons[0] ?? "Brand fit is not contradicted." };
}

/** A learned pattern as the pick reads it. The row's own values, without any it does not store. */
export type LearnedRow = {
  attribute: string;
  value: string;
  metric: string;
  lift: number;
  sample_size: number;
  impressions: number;
  state: string | null;
  p_beat: number | null;
  ci_low: number | null;
  ci_high: number | null;
  surface: string;
  channel: string;
  /** Measured rate for the pattern's metric. Absent on older callers. A retention floor reads it only for retention_3s. */
  observed?: number | null;
};

/**
 * One surface a run learns from, with the channels the run names. A pattern counts for a scope only when it was learned on the scope's
 * surface, and on a channel the run names or on every channel (channel '').
 */
export type LearningScope = { surface: LearningSurface; platforms: readonly string[] };

/** Whether a learned pattern may move a run's pick: the same surface, and a channel the run names or every channel. */
export function patternInScope(row: { surface: string; channel: string }, scope: LearningScope): boolean {
  if (row.surface !== scope.surface) return false;
  return row.channel === "" || scope.platforms.includes(row.channel);
}

/** The weight of a concept from the patterns the brand has learned about its angle, hook type and format, on the scope. */
export function learnedWeightOf(
  concept: Concept,
  rows: LearnedRow[],
  scope: LearningScope | null,
  beatFloor: number | null = null,
  retentionFloor: number | null = null,
): { weight: number; notes: string[] } {
  const attributes: Record<string, string> = { angle: concept.angle, hookType: concept.hookType, format: concept.format };
  let adjustment = 0;
  const notes: string[] = [];
  for (const row of rows) {
    if (!scope || !patternInScope(row, scope)) continue;
    if (!patternClearsBeatFloor(row.p_beat, beatFloor)) continue;
    if (!retentionClearsFloor(row.metric, row.observed ?? null, retentionFloor)) continue;
    const own = attributes[row.attribute];
    if (own === undefined || own === "" || row.value.trim().toLowerCase() !== own.trim().toLowerCase()) continue;
    const pattern: LearnedPattern = {
      attribute: row.attribute,
      value: row.value,
      metric: row.metric as LearnedPattern["metric"],
      lift: row.lift,
      sampleSize: row.sample_size,
      baseline: 0,
      observed: 0,
      summary: "",
      impressions: row.impressions,
      state: (row.state as LearnedPattern["state"]) ?? undefined,
      pBeat: row.p_beat ?? undefined,
      ciLow: row.ci_low ?? undefined,
      ciHigh: row.ci_high ?? undefined,
    };
    const direction = learningDirection(pattern);
    const influence = patternInfluence(pattern);
    if (direction === "POSITIVE") {
      adjustment += influence * Math.min(1, Math.max(0, row.lift));
      notes.push(`${row.attribute} ${row.value} has learned to win on ${row.surface}`);
    } else if (direction === "NEGATIVE") {
      adjustment -= influence * Math.min(1, Math.max(0, -row.lift));
      notes.push(`${row.attribute} ${row.value} has learned to lose on ${row.surface}`);
    }
  }
  return { weight: Math.max(MIN_LEARNED_WEIGHT, 1 + LEARNED_WEIGHT_SCALE * adjustment), notes };
}

/**
 * The learning scopes of a run from its intent. An organic run learns from organic outcomes, and an ad run from paid outcomes. A run
 * with intent both makes creatives for both surfaces, so it has one scope per surface. Each scope weights only its own arm of a
 * concept, so an organic win never moves a paid arm, and a paid win never moves an organic arm.
 */
export function learningScopesOf(settings: { intent: Intent; platforms: readonly string[] }): LearningScope[] {
  if (settings.intent === "organic") return [{ surface: "organic", platforms: settings.platforms }];
  if (settings.intent === "ad") return [{ surface: "paid", platforms: settings.platforms }];
  return [
    { surface: "organic", platforms: settings.platforms },
    { surface: "paid", platforms: settings.platforms },
  ];
}

type Candidate = {
  concept: Concept;
  /** The graded ad to storyboard: the one with the highest observed winner score. */
  researchAdId: string;
  /** The grade that ad carried when it was read. The pick stores its fingerprint. */
  grade: GradeRecord | null;
  bestWinner: number;
  /** Ads whose delivery the source reported. */
  known: number;
  /** Known ads still delivering at their last sighting. */
  running: number;
  /** Confidence of the angle on the ad with the highest winner score, or null when the decode did not record one. */
  confidence: number | null;
};

export type Pick = {
  id: string;
  concept: Concept;
  researchAdId: string;
  score: number;
  rank: number;
  /** The surface whose learned pattern weighted this pick, or '' when the run learned from none. */
  surface: LearningSurface | "";
};

/** One arm's weight for a concept on one surface, and the learned patterns that moved it. */
export type PickWeight = { concept: string; surface: LearningSurface | ""; weight: number; notes: string[] };

export type PickResult = {
  picks: Pick[];
  considered: number;
  filtered: Array<{ concept: string; reason: string }>;
  /** Every arm that was ranked, with the weight it read. A test or a reader can see which surface moved which concept. */
  weights: PickWeight[];
};

type PickRow = {
  research_ad_id: string;
  record: string;
  winner_score: number;
  still_running: boolean | null;
} & GradeRecord;

/**
 * Chooses the run's picks from the brand's graded ads, and stores them in factory_picks (replacing any picks this run stored before).
 * At most `maxPicks` concepts are picked, and only those with a positive score. Nothing is picked when no concept is graded. A concept
 * is picked at most once, even when the run has an arm for each of its surfaces.
 */
export async function pickConceptsForRun(
  sql: Sql,
  input: { organizationId: string; brandId: string; runId: string; maxPicks: number; learning: LearningScope[] },
): Promise<PickResult> {
  const rows = await sql<PickRow>`
    select d.research_ad_id, d.record, t.winner_score, t.still_running,
      t.jev_status, t.jev_action, t.jev_reason, t.jev_engine_id, t.jev_model, t.jev_question_versions, t.jev_policy_version, t.jev_gate_record_id
    from creative_dna d
    join ad_timelines t on t.research_ad_id = d.research_ad_id and t.organization_id = d.organization_id and t.brand_id = d.brand_id
    where d.organization_id = ${input.organizationId} and d.brand_id = ${input.brandId}
      and d.schema_version = ${CREATIVE_DNA_VERSION} and t.winner_score is not null
    order by d.research_ad_id
  `;
  const candidates = new Map<string, Candidate>();
  for (const row of rows) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    const concept = dna?.adId ? conceptOf(dna) : null;
    if (!concept) continue;
    const winner = Number(row.winner_score);
    const confidence = typeof dna.angle?.confidence === "number" && Number.isFinite(dna.angle.confidence) ? dna.angle.confidence : null;
    const candidate: Candidate = candidates.get(concept.key) ?? {
      concept,
      researchAdId: row.research_ad_id,
      grade: row,
      bestWinner: winner,
      known: 0,
      running: 0,
      confidence,
    };
    if (winner > candidate.bestWinner) {
      candidate.bestWinner = winner;
      candidate.researchAdId = row.research_ad_id;
      candidate.grade = row;
      candidate.confidence = confidence;
    }
    if (row.still_running !== null) {
      candidate.known += 1;
      if (row.still_running) candidate.running += 1;
    }
    candidates.set(concept.key, candidate);
  }

  const line = await loadSavedFactoryPipelineConfig(sql, input.organizationId, input.brandId);
  const winnerFloor = line?.gradingThresholds.winnerScoreMin ?? null;
  const beatFloor = line?.gradingThresholds.pBeatMin ?? null;
  const confidenceFloor = line?.gradingThresholds.confidenceMin ?? null;
  const retentionFloor = line?.gradingThresholds.retention3sMin ?? null;
  const brain = await loadFactoryBrain(sql, input.organizationId, input.brandId);
  // Only the surfaces the run makes creatives for are read, and only the channels it names (or every channel). The filter is in the
  // query and again in learnedWeightOf, so a pattern from another surface can never move an arm. No scope reads no pattern at all.
  const surfaces = [...new Set(input.learning.map((scope) => scope.surface))];
  const channels = [...new Set(input.learning.flatMap((scope) => scope.platforms))];
  const learned = surfaces.length === 0
    ? []
    : await sql<LearnedRow>`
        select attribute, value, metric, lift, sample_size, impressions, state, p_beat, ci_low, ci_high, surface, channel, observed
        from learned_patterns
        where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and scope = 'brand'
          and surface = any(${surfaces}) and (channel = '' or channel = any(${channels}))
      `;
  const proposalPatterns = await sql<{
    attribute: string;
    value: string;
    surface: string;
    lift: number;
    sample_size: number;
    impressions: number;
    p_beat: number | null;
    ci_low: number | null;
    ci_high: number | null;
  }>`
    select attribute, value, surface, lift, sample_size, impressions, p_beat, ci_low, ci_high from learned_patterns
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and scope = 'brand'
      and surface in ('organic', 'paid') and channel = ''
  `;
  const proposalRows = proposalPatterns.map((row) => ({
    attribute: row.attribute,
    value: row.value,
    surface: row.surface,
    lift: Number(row.lift),
    sampleSize: Number(row.sample_size),
    impressions: Number(row.impressions),
    pBeat: row.p_beat ?? undefined,
    ciLow: row.ci_low ?? undefined,
    ciHigh: row.ci_high ?? undefined,
  }));
  const filtered: Array<{ concept: string; reason: string }> = [];
  const arms: ThompsonArm[] = [];
  const weights: PickWeight[] = [];
  // Without a scope the arm is the concept itself, as before. With several scopes each arm is named by its surface, so the two arms of
  // a concept are separate draws.
  const scopes: Array<LearningScope | null> = input.learning.length > 0 ? input.learning : [null];
  const proposals: SurfaceProposal[] = [];
  const armById = new Map<string, { candidate: Candidate; surface: LearningSurface | ""; weight: number }>();
  for (const candidate of candidates.values()) {
    const fit = brandFitOf(candidate.concept, brain.values, brain.completeness);
    if (!winnerClearsFloor(candidate.bestWinner, winnerFloor)) {
      filtered.push({
        concept: candidate.concept.label,
        reason: `The observed winner score ${candidate.bestWinner} is below this brand's floor of ${winnerFloor}.`,
      });
      continue;
    }
    if (!confidenceClearsFloor(candidate.confidence, confidenceFloor)) {
      filtered.push({
        concept: candidate.concept.label,
        reason: `The decoded angle confidence ${candidate.confidence} is below this brand's floor of ${confidenceFloor}.`,
      });
      continue;
    }
    if (!fit.passes) {
      filtered.push({ concept: candidate.concept.label, reason: fit.reason });
      continue;
    }
    proposals.push(...crossSurfaceProposals(candidate.concept, proposalRows));
    for (const scope of scopes) {
      const { weight, notes } = learnedWeightOf(candidate.concept, learned, scope, beatFloor, retentionFloor);
      const surface: LearningSurface | "" = scope ? scope.surface : "";
      const id = scopes.length > 1 && scope ? `${scope.surface}|${candidate.concept.key}` : candidate.concept.key;
      arms.push({ id, successes: candidate.running, failures: candidate.known - candidate.running, weight });
      armById.set(id, { candidate, surface, weight });
      weights.push({ concept: candidate.concept.label, surface, weight, notes });
    }
  }

  const ranked = thompsonRank({ arms, seed: input.runId });
  const limit = Math.max(0, input.maxPicks);
  const taken = new Set<string>();
  const chosen: Array<{ id: string; rank: number; score: number }> = [];
  for (const item of ranked) {
    if (chosen.length >= limit) break;
    if (item.score <= 0) continue;
    const arm = armById.get(item.id);
    if (!arm) continue;
    // One pick per concept: the first arm that ranks for it is the surface the concept is picked for.
    if (taken.has(arm.candidate.concept.key)) continue;
    taken.add(arm.candidate.concept.key);
    chosen.push({ id: item.id, rank: item.rank, score: item.score });
  }

  await sql`delete from factory_picks where run_id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  await sql`delete from factory_surface_proposals where run_id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  for (const proposal of proposals) {
    await sql`
      insert into factory_surface_proposals (
        id, organization_id, brand_id, run_id, concept, from_surface, to_surface, attribute, value, reason
      ) values (
        ${`proposal:${input.runId}:${proposal.concept}:${proposal.fromSurface}:${proposal.toSurface}:${proposal.attribute}:${proposal.value}`},
        ${input.organizationId}, ${input.brandId}, ${input.runId}, ${proposal.concept},
        ${proposal.fromSurface}, ${proposal.toSurface}, ${proposal.attribute}, ${proposal.value}, ${proposal.reason}
      )
      on conflict (organization_id, run_id, concept, from_surface, to_surface, attribute, value) do nothing
    `;
  }
  const picks: Pick[] = [];
  for (const item of chosen) {
    const arm = armById.get(item.id);
    if (!arm) continue;
    const candidate = arm.candidate;
    const id = `pick:${input.runId}:${item.rank}`;
    const fingerprint = predictionFingerprint(candidate.grade);
    await sql`
      insert into factory_picks (id, organization_id, brand_id, run_id, concept, research_ad_id, score, method, surface, grade_fingerprint)
      values (${id}, ${input.organizationId}, ${input.brandId}, ${input.runId}, ${candidate.concept.label},
        ${candidate.researchAdId}, ${item.score}, 'thompson', ${arm.surface}, ${fingerprint})
    `;
    picks.push({ id, concept: candidate.concept, researchAdId: candidate.researchAdId, score: item.score, rank: item.rank, surface: arm.surface });
  }
  return { picks, considered: candidates.size, filtered, weights };
}
