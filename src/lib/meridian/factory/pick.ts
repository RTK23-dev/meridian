/**
 * The Pick stage (NORTH_STAR section 5, pick): choose what to make next from the graded concepts.
 *
 * A concept is one creative angle, with its format and hook type, read from the creative DNA of the graded ads. A pick
 * - is filtered out when the brand's own brain rules the concept out: the brain is too thin to confirm fit, or the concept's words
 *   include one the brand avoids;
 * - is weighted by what the brand has already learned on the run's own surface (organic or paid) and channels, from its learned
 *   patterns (learning/engine.ts), by the direction and the evidence behind each pattern that names one of its attributes;
 * - gets one Thompson draw from its delivery record (thompson.ts). A concept with proven delivery and one with none both have a
 *   chance, so the run balances proven angles against untested ones. The seed is the run id, so a run's picks can be reproduced.
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
import { thompsonRank, type ThompsonArm } from "./thompson.ts";
import type { Intent } from "./run-settings.ts";

/** How far a learned pattern moves a concept's weight at most. A ranking scale, uncalibrated. */
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
};

/**
 * The surface and channels a run learns from. A pattern counts only when it was learned on this surface, and on a channel the run
 * names or on every channel (channel ''). A run with no single surface (intent both) has no scope, so no pattern counts for it.
 */
export type LearningScope = { surface: LearningSurface; platforms: readonly string[] };

/** Whether a learned pattern may move a run's pick: the same surface, and a channel the run names or every channel. */
export function patternInScope(row: { surface: string; channel: string }, scope: LearningScope): boolean {
  if (row.surface !== scope.surface) return false;
  return row.channel === "" || scope.platforms.includes(row.channel);
}

/** The weight of a concept from the patterns the brand has learned about its angle, hook type and format, on the run's scope. */
export function learnedWeightOf(concept: Concept, rows: LearnedRow[], scope: LearningScope | null): { weight: number; notes: string[] } {
  const attributes: Record<string, string> = { angle: concept.angle, hookType: concept.hookType, format: concept.format };
  let adjustment = 0;
  const notes: string[] = [];
  for (const row of rows) {
    if (!scope || !patternInScope(row, scope)) continue;
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
 * The learning scope of a run from its intent. An organic run learns from organic outcomes, and an ad run from paid outcomes. A run
 * with intent both publishes on both surfaces, so no single surface's patterns describe it: it gets no learned weight, and the run
 * says so in its pick notes rather than blend the two.
 */
export function learningScopeOf(settings: { intent: Intent; platforms: readonly string[] }): LearningScope | null {
  if (settings.intent === "organic") return { surface: "organic", platforms: settings.platforms };
  if (settings.intent === "ad") return { surface: "paid", platforms: settings.platforms };
  return null;
}

type Candidate = {
  concept: Concept;
  /** The graded ad to storyboard: the one with the highest observed winner score. */
  researchAdId: string;
  bestWinner: number;
  /** Ads whose delivery the source reported. */
  known: number;
  /** Known ads still delivering at their last sighting. */
  running: number;
};

export type Pick = { id: string; concept: Concept; researchAdId: string; score: number; rank: number };

export type PickResult = {
  picks: Pick[];
  considered: number;
  filtered: Array<{ concept: string; reason: string }>;
};

/**
 * Chooses the run's picks from the brand's graded ads, and stores them in factory_picks (replacing any picks this run stored before).
 * At most `maxPicks` concepts are picked, and only those with a positive score. Nothing is picked when no concept is graded.
 */
export async function pickConceptsForRun(
  sql: Sql,
  input: { organizationId: string; brandId: string; runId: string; maxPicks: number; learning: LearningScope | null },
): Promise<PickResult> {
  const rows = await sql<{ research_ad_id: string; record: string; winner_score: number; still_running: boolean | null }>`
    select d.research_ad_id, d.record, t.winner_score, t.still_running
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
    const candidate: Candidate = candidates.get(concept.key) ?? {
      concept,
      researchAdId: row.research_ad_id,
      bestWinner: winner,
      known: 0,
      running: 0,
    };
    if (winner > candidate.bestWinner) {
      candidate.bestWinner = winner;
      candidate.researchAdId = row.research_ad_id;
    }
    if (row.still_running !== null) {
      candidate.known += 1;
      if (row.still_running) candidate.running += 1;
    }
    candidates.set(concept.key, candidate);
  }

  const brain = await loadFactoryBrain(sql, input.organizationId, input.brandId);
  // Only the run's own surface is read, and only the channels it names (or every channel). The filter is in the query and again in
  // learnedWeightOf, so a pattern from another surface can never move this run's weights. No scope reads no pattern at all.
  const learned = input.learning
    ? await sql<LearnedRow>`
        select attribute, value, metric, lift, sample_size, impressions, state, p_beat, ci_low, ci_high, surface, channel
        from learned_patterns
        where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and scope = 'brand'
          and surface = ${input.learning.surface} and (channel = '' or channel = any(${[...input.learning.platforms]}))
      `
    : [];
  const filtered: Array<{ concept: string; reason: string }> = [];
  const arms: ThompsonArm[] = [];
  const byKey = new Map<string, Candidate & { weight: number }>();
  for (const candidate of candidates.values()) {
    const fit = brandFitOf(candidate.concept, brain.values, brain.completeness);
    if (!fit.passes) {
      filtered.push({ concept: candidate.concept.label, reason: fit.reason });
      continue;
    }
    const { weight } = learnedWeightOf(candidate.concept, learned, input.learning);
    arms.push({ id: candidate.concept.key, successes: candidate.running, failures: candidate.known - candidate.running, weight });
    byKey.set(candidate.concept.key, { ...candidate, weight });
  }

  const ranked = thompsonRank({ arms, seed: input.runId });
  const chosen = ranked.filter((item) => item.score > 0).slice(0, Math.max(0, input.maxPicks));
  await sql`delete from factory_picks where run_id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  const picks: Pick[] = [];
  for (const item of chosen) {
    const candidate = byKey.get(item.id);
    if (!candidate) continue;
    const id = `pick:${input.runId}:${item.rank}`;
    await sql`
      insert into factory_picks (id, organization_id, brand_id, run_id, concept, research_ad_id, score, method)
      values (${id}, ${input.organizationId}, ${input.brandId}, ${input.runId}, ${candidate.concept.label},
        ${candidate.researchAdId}, ${item.score}, 'thompson')
    `;
    picks.push({ id, concept: candidate.concept, researchAdId: candidate.researchAdId, score: item.score, rank: item.rank });
  }
  return { picks, considered: candidates.size, filtered };
}
