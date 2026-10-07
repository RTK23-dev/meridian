export type AdSighting = {
  seenAt: string;
  platforms: string[];
  countries: string[];
  reachLow: number | null;
  reachHigh: number | null;
  stillRunning: boolean;
};

export type AdTimeline = {
  firstSeen: string;
  lastSeen: string;
  stillRunning: boolean;
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

export function buildAdTimeline(input: {
  sightings: AdSighting[];
  siblingVariants?: number;
  now?: string;
}): AdTimeline | null {
  const dated = input.sightings
    .map((row) => ({ row, time: parseTime(row.seenAt) }))
    .filter((item): item is { row: AdSighting; time: number } => item.time !== null)
    .sort((a, b) => a.time - b.time);
  if (dated.length === 0) return null;
  const first = dated[0];
  const last = dated[dated.length - 1];
  const now = parseTime(input.now ?? "") ?? Date.now();
  const platforms = [...new Set(dated.flatMap((item) => item.row.platforms.map((value) => value.trim()).filter(Boolean)))];
  const countries = [...new Set(dated.flatMap((item) => item.row.countries.map((value) => value.trim()).filter(Boolean)))];
  const reachLows = dated.map((item) => item.row.reachLow).filter((value): value is number => value != null);
  const reachHighs = dated.map((item) => item.row.reachHigh).filter((value): value is number => value != null);
  const stillRunning = last.row.stillRunning;
  const end = stillRunning ? now : last.time;
  return {
    firstSeen: first.row.seenAt,
    lastSeen: last.row.seenAt,
    stillRunning,
    daysRunning: Math.max(0, Math.round((end - first.time) / 86_400_000)),
    siblingVariants: Math.max(0, input.siblingVariants ?? 0),
    platforms,
    countries,
    reachLow: reachLows.length ? Math.min(...reachLows) : null,
    reachHigh: reachHighs.length ? Math.max(...reachHighs) : null,
  };
}
