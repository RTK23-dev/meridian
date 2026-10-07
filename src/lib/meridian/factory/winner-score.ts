/** Public-signal Winner Score. Weights are fitted later on the brand's own account. */

export type WinnerEvidence = {
  daysRunning: number;
  stillRunning: boolean;
  iterationCount: number;
  countries: number;
  platforms: number;
  advertiserSurvivorRate: number | null;
  creativeQuality: number | null;
};

export type WinnerScore = {
  score: number;
  low: number;
  high: number;
  evidence: string[];
  components: Record<string, number>;
};

const DEFAULT_WEIGHTS = {
  survival: 0.4,
  iteration: 0.2,
  spread: 0.15,
  advertiser: 0.15,
  quality: 0.1,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function survivalScore(days: number, stillRunning: boolean): number {
  const daysScore = 1 - Math.exp(-Math.max(0, days) / 30);
  return clamp01(daysScore * (stillRunning ? 1 : 0.65));
}

function iterationScore(count: number): number {
  return clamp01(Math.log2(1 + Math.max(0, count)) / 4);
}

function spreadScore(countries: number, platforms: number): number {
  return clamp01(Math.min(1, Math.max(0, countries) / 9) * 0.7 + Math.min(1, Math.max(0, platforms) / 4) * 0.3);
}

export function winnerScore(input: WinnerEvidence, weights = DEFAULT_WEIGHTS): WinnerScore {
  const survival = survivalScore(input.daysRunning, input.stillRunning);
  const iteration = iterationScore(input.iterationCount);
  const spread = spreadScore(input.countries, input.platforms);
  const advertiser = input.advertiserSurvivorRate == null ? 0.4 : clamp01(input.advertiserSurvivorRate);
  const quality = input.creativeQuality == null ? 0 : Math.min(0.6, clamp01(input.creativeQuality));
  const raw =
    survival * weights.survival +
    iteration * weights.iteration +
    spread * weights.spread +
    advertiser * weights.advertiser +
    quality * weights.quality;
  const missing: string[] = [];
  if (input.advertiserSurvivorRate == null) missing.push("advertiser track record");
  if (input.creativeQuality == null) missing.push("creative quality");
  const uncertainty = 0.08 + missing.length * 0.06 + (input.daysRunning < 7 ? 0.08 : 0);
  const score = Math.round(clamp01(raw) * 1000) / 1000;
  const evidence: string[] = [
    input.stillRunning ? `live ${Math.round(input.daysRunning)} days` : `ran ${Math.round(input.daysRunning)} days, now off`,
    `${input.iterationCount} variant${input.iterationCount === 1 ? "" : "s"}`,
    `${input.countries} countr${input.countries === 1 ? "y" : "ies"}`,
    `${input.platforms} platform${input.platforms === 1 ? "" : "s"}`,
  ];
  if (input.advertiserSurvivorRate != null) {
    evidence.push(`advertiser survivor rate ${(input.advertiserSurvivorRate * 100).toFixed(0)}%`);
  }
  if (input.creativeQuality != null) evidence.push("creative quality scored from DNA");
  return {
    score,
    low: Math.round(clamp01(score - uncertainty) * 1000) / 1000,
    high: Math.round(clamp01(score + uncertainty) * 1000) / 1000,
    evidence,
    components: { survival, iteration, spread, advertiser, quality },
  };
}

export function backtestWinnerScore(rows: {
  score: number;
  stillLiveAfter30Days: boolean;
}[]): { top20HitRate: number | null; randomHitRate: number | null; lift: number | null; n: number } {
  if (rows.length < 10) {
    return { top20HitRate: null, randomHitRate: null, lift: null, n: rows.length };
  }
  const live = rows.filter((row) => row.stillLiveAfter30Days).length / rows.length;
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  const topCount = Math.max(1, Math.round(rows.length * 0.2));
  const topLive = ranked.slice(0, topCount).filter((row) => row.stillLiveAfter30Days).length / topCount;
  return {
    top20HitRate: Math.round(topLive * 1000) / 1000,
    randomHitRate: Math.round(live * 1000) / 1000,
    lift: live === 0 ? null : Math.round((topLive / live) * 1000) / 1000,
    n: rows.length,
  };
}

export async function runWinnerScoreBacktest(
  sql: import("../learning/store.ts").Sql,
  input: { organizationId?: string; brandId?: string } = {},
): Promise<{
  top20HitRate: number | null;
  randomHitRate: number | null;
  lift: number | null;
  n: number;
  report: string;
}> {
  let rows: { winner_score: number | null; days_running: number }[];
  if (input.organizationId && input.brandId) {
    rows = await sql<{ winner_score: number | null; days_running: number }>`
      select winner_score, days_running
      from ad_timelines
      where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and winner_score is not null
    `;
  } else {
    rows = await sql<{ winner_score: number | null; days_running: number }>`
      select winner_score, days_running
      from ad_timelines
      where winner_score is not null
    `;
  }

  const backtestInput = rows
    .filter((r) => r.winner_score != null)
    .map((r) => ({
      score: r.winner_score!,
      stillLiveAfter30Days: r.days_running >= 30,
    }));

  const result = backtestWinnerScore(backtestInput);
  const report =
    result.lift !== null
      ? `Winner Score Backtest: Top 20% hit rate is ${(result.top20HitRate! * 100).toFixed(1)}% vs ${(result.randomHitRate! * 100).toFixed(1)}% baseline (lift: ${result.lift.toFixed(2)}x across ${result.n} tracked ads).`
      : `Winner Score Backtest: Insufficient historical data (n = ${result.n}, requires at least 10 tracked ads). Scores remain uncalibrated.`;

  return {
    ...result,
    report,
  };
}
