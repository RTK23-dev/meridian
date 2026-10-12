import type { Sql } from "../learning/store.ts";
import { winnerScore } from "./winner-score.ts";

/** One observation of an ad. `stillRunning` is null when the source did not report whether the ad was delivering. */
export type AdSighting = {
  seenAt: string;
  platforms: string[];
  countries: string[];
  reachLow: number | null;
  reachHigh: number | null;
  stillRunning: boolean | null;
};

export type AdTimeline = {
  firstSeen: string;
  lastSeen: string;
  stillRunning: boolean | null;
  daysRunning: number;
  siblingVariants: number;
  platforms: string[];
  countries: string[];
  reachLow: number | null;
  reachHigh: number | null;
};

function parseTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Days running are measured between the first and the last observation. Nothing after the last observation is known, so an
 * ad that was still delivering at its last sighting is not counted as running today. A newer sighting extends the run.
 */
export function buildAdTimeline(input: {
  sightings: AdSighting[];
  siblingVariants?: number;
}): AdTimeline | null {
  const dated = input.sightings
    .map((row) => ({ row, time: parseTime(row.seenAt) }))
    .filter((item): item is { row: AdSighting; time: number } => item.time !== null)
    .sort((a, b) => a.time - b.time);
  if (dated.length === 0) return null;
  const first = dated[0]!;
  const last = dated[dated.length - 1]!;
  const platforms = [...new Set(dated.flatMap((item) => item.row.platforms.map((value) => value.trim()).filter(Boolean)))];
  const countries = [...new Set(dated.flatMap((item) => item.row.countries.map((value) => value.trim()).filter(Boolean)))];
  const reachLows = dated.map((item) => item.row.reachLow).filter((value): value is number => value != null);
  const reachHighs = dated.map((item) => item.row.reachHigh).filter((value): value is number => value != null);
  return {
    firstSeen: first.row.seenAt,
    lastSeen: last.row.seenAt,
    stillRunning: last.row.stillRunning,
    daysRunning: Math.max(0, Math.round((last.time - first.time) / 86_400_000)),
    siblingVariants: Math.max(0, input.siblingVariants ?? 0),
    platforms,
    countries,
    reachLow: reachLows.length ? Math.min(...reachLows) : null,
    reachHigh: reachHighs.length ? Math.max(...reachHighs) : null,
  };
}

/**
 * Daily timeline re-check job. It re-scores each stored timeline from its own first and last sighting. A re-check sees no new
 * evidence, so it never lengthens an ad's run: days running stay measured to the last sighting until a newer collection adds one.
 */
export async function recheckAdTimelines(
  sql: Sql,
  input: { organizationId: string; brandId: string },
): Promise<{ recheckedCount: number }> {
  const rows = await sql<{
    id: string;
    first_seen: unknown;
    last_seen: unknown;
    still_running: boolean | null;
    sibling_variants: number;
    platforms: string;
    countries: string;
  }>`
    select id, first_seen, last_seen, still_running, sibling_variants, platforms, countries
    from ad_timelines
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;

  let recheckedCount = 0;

  for (const row of rows) {
    const firstTime = new Date(String(row.first_seen)).getTime();
    const lastTime = new Date(String(row.last_seen)).getTime();
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) continue;

    const daysRunning = Math.max(0, Math.round((lastTime - firstTime) / 86_400_000));
    let platforms: string[] = [];
    let countries: string[] = [];
    try {
      platforms = JSON.parse(row.platforms);
      countries = JSON.parse(row.countries);
    } catch {
      platforms = [];
      countries = [];
    }

    const scored = winnerScore({
      daysRunning,
      stillRunning: row.still_running,
      iterationCount: Math.max(1, row.sibling_variants),
      countries: countries.length,
      platforms: platforms.length,
      advertiserSurvivorRate: null,
      creativeQuality: null,
    });

    await sql`
      update ad_timelines
      set days_running = ${daysRunning},
          winner_score = ${scored.score},
          winner_low = ${scored.low},
          winner_high = ${scored.high},
          evidence = ${JSON.stringify(scored.evidence)},
          updated_at = now()
      where id = ${row.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    recheckedCount += 1;
  }

  return { recheckedCount };
}
