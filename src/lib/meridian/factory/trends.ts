export type ConceptAd = {
  id: string;
  concept: string;
  advertiser: string;
  week: string;
  niche: string;
};

export type ConceptMomentum = "rising" | "peaking" | "fading" | "stable";

export type ConceptTrend = {
  concept: string;
  adsThisWeek: number;
  adsPrevWeek: number;
  newAdvertisers: number;
  momentum: ConceptMomentum;
  saturation: number;
  whitespace: boolean;
  evidence: string[];
};

function weekKey(value: string): string {
  return value.trim().slice(0, 10);
}

export function clusterConcepts(ads: ConceptAd[]): Map<string, ConceptAd[]> {
  const groups = new Map<string, ConceptAd[]>();
  for (const ad of ads) {
    const concept = ad.concept.trim().toLowerCase();
    if (!concept) continue;
    const list = groups.get(concept) ?? [];
    list.push(ad);
    groups.set(concept, list);
  }
  return groups;
}

export function trendReport(input: {
  ads: ConceptAd[];
  thisWeek: string;
  prevWeek: string;
  brandConcepts: string[];
}): ConceptTrend[] {
  const groups = clusterConcepts(input.ads);
  const brand = new Set(input.brandConcepts.map((item) => item.trim().toLowerCase()).filter(Boolean));
  const thisWeek = weekKey(input.thisWeek);
  const prevWeek = weekKey(input.prevWeek);
  const trends: ConceptTrend[] = [];
  for (const [concept, rows] of groups) {
    const current = rows.filter((row) => weekKey(row.week) === thisWeek);
    const previous = rows.filter((row) => weekKey(row.week) === prevWeek);
    const advertisersNow = new Set(current.map((row) => row.advertiser));
    const advertisersPrev = new Set(previous.map((row) => row.advertiser));
    const newAdvertisers = [...advertisersNow].filter((name) => !advertisersPrev.has(name)).length;
    const adsThisWeek = current.length;
    const adsPrevWeek = previous.length;
    const ratio = adsPrevWeek === 0 ? (adsThisWeek > 0 ? 2 : 1) : adsThisWeek / adsPrevWeek;
    let momentum: ConceptMomentum = "stable";
    if (adsThisWeek === 0 && adsPrevWeek > 0) momentum = "fading";
    else if (ratio >= 1.4 && newAdvertisers > 0) momentum = "rising";
    else if (ratio <= 0.7) momentum = "fading";
    else if (adsThisWeek >= 6 && ratio < 1.15 && ratio > 0.85) momentum = "peaking";
    const saturation = Math.min(1, advertisersNow.size / 8);
    trends.push({
      concept,
      adsThisWeek,
      adsPrevWeek,
      newAdvertisers,
      momentum,
      saturation,
      whitespace: !brand.has(concept) && adsThisWeek > 0,
      evidence: [
        `${adsThisWeek} ads this week vs ${adsPrevWeek} last week`,
        `${newAdvertisers} new advertisers`,
        `${advertisersNow.size} advertisers in-niche`,
      ],
    });
  }
  return trends.sort((a, b) => b.adsThisWeek - a.adsThisWeek || a.concept.localeCompare(b.concept));
}

export function risingKeptRising(history: { week: string; rising: string[] }[]): number | null {
  if (history.length < 3) return null;
  const first = history[0];
  if (first.rising.length === 0) return null;
  const later = history.slice(1);
  let kept = 0;
  for (const concept of first.rising) {
    if (later.every((week) => week.rising.includes(concept))) kept += 1;
  }
  return Math.round((kept / first.rising.length) * 1000) / 1000;
}
