import type { Sql } from "../learning/store.ts";

/**
 * Cheap ranking before expensive research. Each ad that would be downloaded, transcribed, and analyzed
 * is scored from metadata alone. Only the top ads reach the expensive steps, and every decision is stored
 * with its score and reason.
 *
 * The weights are seed priors. They were chosen by hand and have not been calibrated against outcomes, so
 * the score is an ordering, not a probability. Calibration is a P5 concern (docs/ROADMAP.md).
 */
export const GATE_PARAMETER_STATE = "seed_prior" as const;

export const GATE_WEIGHTS = {
  textPresence: 0.4,
  copyLength: 0.2,
  recency: 0.4,
} as const;

/** A copy length at or above this counts as fully informative. Shorter copy scores proportionally. */
export const GATE_FULL_COPY_LENGTH = 200;

export interface GateCandidate {
  adId: string;
  externalId: string;
  copy: string;
  headline: string;
  description: string;
  capturedAt: string;
  publishedAt: string | null;
}

export type GateSkipReason = "duplicate_of_analyzed" | "duplicate_in_run" | "below_run_cap";

export interface GateDecision {
  /** Ad ids that pass the gate, best first. */
  admitted: string[];
  skipped: { adId: string; score: number; reason: GateSkipReason }[];
  /** The score of every candidate, admitted or skipped. */
  scores: Record<string, number>;
}

/** The key two ads share when their written content is the same. Empty content is never a duplicate. */
export function gateCopyKey(ad: Pick<GateCandidate, "copy" | "headline" | "description">): string {
  return `${ad.copy} ${ad.headline} ${ad.description}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function timestampOf(ad: GateCandidate): number {
  const value = Date.parse(ad.publishedAt ?? ad.capturedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Ranks candidates without any perception step. Ads whose copy matches one already analyzed for the brand,
 * or an earlier candidate in this run, are skipped as duplicates. The best `maxAdsPerRun` of the rest are
 * admitted. Ties are broken by external id, so the same input always gives the same decision.
 */
export function rankGateCandidates(
  candidates: GateCandidate[],
  options: { maxAdsPerRun: number; analyzedCopyKeys: Set<string> },
): GateDecision {
  const timestamps = candidates.map(timestampOf);
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : 0;
  const scores: Record<string, number> = {};
  const scored = candidates.map((ad, index) => {
    const textPresence = gateCopyKey(ad).length > 0 ? 1 : 0;
    const copyLength = Math.min(1, ad.copy.trim().length / GATE_FULL_COPY_LENGTH);
    const recency = latest === earliest ? 1 : (timestamps[index]! - earliest) / (latest - earliest);
    const score = Math.round((GATE_WEIGHTS.textPresence * textPresence + GATE_WEIGHTS.copyLength * copyLength + GATE_WEIGHTS.recency * recency) * 1e6) / 1e6;
    scores[ad.adId] = score;
    return { ad, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.ad.externalId < b.ad.externalId ? -1 : a.ad.externalId > b.ad.externalId ? 1 : 0));

  const skipped: GateDecision["skipped"] = [];
  const seenThisRun = new Set<string>();
  const eligible: { ad: GateCandidate; score: number }[] = [];
  for (const entry of scored) {
    const key = gateCopyKey(entry.ad);
    if (key && options.analyzedCopyKeys.has(key)) {
      skipped.push({ adId: entry.ad.adId, score: entry.score, reason: "duplicate_of_analyzed" });
    } else if (key && seenThisRun.has(key)) {
      skipped.push({ adId: entry.ad.adId, score: entry.score, reason: "duplicate_in_run" });
    } else {
      if (key) seenThisRun.add(key);
      eligible.push(entry);
    }
  }

  const cap = Math.max(0, Math.floor(options.maxAdsPerRun));
  const admitted = eligible.slice(0, cap).map((entry) => entry.ad.adId);
  for (const entry of eligible.slice(cap)) {
    skipped.push({ adId: entry.ad.adId, score: entry.score, reason: "below_run_cap" });
  }
  return { admitted, skipped, scores };
}

/**
 * Applies the gate to a run's ads and records each decision on its research_ads row. Skipped ads are marked
 * `gate_skipped` with their score and reason. Admitted ads keep their status and record their score.
 */
export async function applyCheapGate(
  sql: Sql,
  input: { organizationId: string; brandId: string; candidates: GateCandidate[]; maxAdsPerRun: number },
): Promise<GateDecision> {
  const analyzed = await sql<{ id: string; copy: string; headline: string; description: string }>`
    select id, copy, headline, description from research_ads
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and analysis_status = 'analyzed'
    order by updated_at desc
    limit 500
  `;
  // An ad's own earlier analysis (from a retried run) is not a copy of itself, so it is left out of the set.
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.adId));
  const decision = rankGateCandidates(input.candidates, {
    maxAdsPerRun: input.maxAdsPerRun,
    analyzedCopyKeys: new Set(analyzed.filter((row) => !candidateIds.has(row.id)).map((row) => gateCopyKey({ copy: row.copy, headline: row.headline, description: row.description }))),
  });
  for (const item of decision.skipped) {
    await sql`
      update research_ads set analysis_status = 'gate_skipped', gate_score = ${item.score}, gate_reason = ${item.reason}, updated_at = now()
      where id = ${item.adId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId} and analysis_status = 'pending'
    `;
  }
  for (const adId of decision.admitted) {
    await sql`
      update research_ads set gate_score = ${decision.scores[adId]!}, gate_reason = 'admitted', updated_at = now()
      where id = ${adId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
  }
  return decision;
}

/** Ads per collection run that reach the expensive steps. An operational cap, not a score. */
export const GATE_DEFAULT_MAX_ADS_PER_RUN = 20;

export function gateMaxAdsPerRun(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RESEARCH_GATE_MAX_ADS?.trim();
  if (!raw) return GATE_DEFAULT_MAX_ADS_PER_RUN;
  const value = Number(raw);
  if (!Number.isFinite(value)) return GATE_DEFAULT_MAX_ADS_PER_RUN;
  return Math.min(200, Math.max(0, Math.floor(value)));
}
