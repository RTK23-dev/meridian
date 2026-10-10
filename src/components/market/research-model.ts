/**
 * Pure rules for the market research screen. This module imports nothing, so the rules can run under
 * `node --experimental-strip-types`. A missing value stays null: it is never shown as zero.
 */

export type AnalysisFieldView = { value?: string; confidence?: number; evidence?: string[] };
export type AnalysisSegment = { id?: string; text?: string; startMs?: number | null; endMs?: number | null; role?: string; confidence?: number };
export type AnalysisClaim = { text?: string; type?: string; evidence?: string[] };
export type AnalysisView = {
  topic?: AnalysisFieldView;
  openingMove?: AnalysisFieldView;
  hookMechanism?: AnalysisFieldView;
  hook?: AnalysisFieldView;
  structure?: AnalysisFieldView;
  evidenceOffered?: AnalysisFieldView;
  emotionalAppeal?: AnalysisFieldView;
  adviceSpecificity?: AnalysisFieldView;
  cta?: AnalysisFieldView;
  segments?: AnalysisSegment[];
  claims?: AnalysisClaim[];
};

/** The fields of a research ad that these rules read. The screen passes its server rows, which carry more. */
export type ResearchAdRow = {
  id: string;
  externalId: string;
  advertiser: string;
  url: string;
  capturedAt: string;
  publishedAt: string | null;
  copy: string;
  headline: string;
  mediaType: string;
  mediaStatus: string;
  mediaBytes: number;
  durationMs: number;
  transcriptStatus: string;
  transcript: string;
  segments: string;
  analysisStatus: string;
  analysis: string;
  confidence: number;
  reviewRequired: boolean;
  provider: string;
  model: string;
  schemaVersion: string;
  error: string;
};

export type ResearchRunRow = {
  id: string;
  searchTerms: string;
  country: string;
  status: string;
  collectedCount: number;
  analyzedCount: number;
  error: string;
  createdAt: string;
};

/** Caps stated on the screen. They come from the collection contract, not from a stored total. */
export const RESEARCH_AD_CAP = 100;
export const RESEARCH_MEDIA_CAP_MB = 100;
export const RESEARCH_VIDEO_CAP_MB = 24;

/** research_ads are only written by the Meta Ad Library collector. The server does not return a source column yet. */
export const META_SOURCE_KEY = "meta_ad_library";
export const META_SOURCE_LABEL = "Meta Ad Library";

export type ResearchState = "collected" | "media stored" | "transcribed" | "analyzed" | "needs review";

export const RESEARCH_STATES: ReadonlyArray<{ key: ResearchState; label: string }> = [
  { key: "collected", label: "Collected" },
  { key: "media stored", label: "Media stored" },
  { key: "transcribed", label: "Transcribed" },
  { key: "analyzed", label: "Analysed" },
  { key: "needs review", label: "Needs review" },
];

export const FIELD_FILTERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "topic", label: "Topic" },
  { key: "openingMove", label: "Opening move" },
  { key: "hookMechanism", label: "Hook mechanism" },
  { key: "hook", label: "Hook" },
  { key: "structure", label: "Structure" },
  { key: "cta", label: "CTA" },
  { key: "segmentRole", label: "Segment role" },
];

export type AnalysisFieldKey = "topic" | "openingMove" | "hookMechanism" | "hook" | "structure" | "evidenceOffered" | "emotionalAppeal" | "adviceSpecificity" | "cta";

export const ANALYSIS_FIELD_LABELS: ReadonlyArray<{ key: AnalysisFieldKey; label: string }> = [
  { key: "topic", label: "Topic" },
  { key: "openingMove", label: "Opening move" },
  { key: "hookMechanism", label: "Hook mechanism" },
  { key: "hook", label: "Hook" },
  { key: "structure", label: "Structure" },
  { key: "evidenceOffered", label: "Evidence offered" },
  { key: "emotionalAppeal", label: "Emotional appeal" },
  { key: "adviceSpecificity", label: "Advice specificity" },
  { key: "cta", label: "CTA" },
];

export function parseAnalysis(value: string): AnalysisView | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AnalysisView : null;
  } catch {
    return null;
  }
}

export function stateLabel(state: string): string {
  return RESEARCH_STATES.find((item) => item.key === state)?.label ?? "Collected";
}

export function researchAdState(ad: Pick<ResearchAdRow, "analysisStatus" | "reviewRequired" | "transcriptStatus" | "mediaStatus">): ResearchState {
  if (ad.analysisStatus === "review" || (ad.analysisStatus === "analyzed" && ad.reviewRequired)) return "needs review";
  if (ad.analysisStatus === "analyzed") return "analyzed";
  if (ad.transcriptStatus === "completed" || ad.transcriptStatus === "transcribed") return "transcribed";
  if (ad.mediaStatus === "stored") return "media stored";
  return "collected";
}

/** A structured analysis exists only when the stored JSON parses. Without one, confidence is unknown, not zero. */
export function hasAnalysis(ad: Pick<ResearchAdRow, "analysis">): boolean {
  return parseAnalysis(ad.analysis) !== null;
}

export function analysisConfidence(ad: Pick<ResearchAdRow, "analysis" | "confidence">): number | null {
  if (!hasAnalysis(ad) || !Number.isFinite(ad.confidence)) return null;
  return ad.confidence;
}

/** A finite number, or null. Missing and non-finite values are unknown. */
export function knownNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function confidenceText(value: number | null): string {
  return value === null ? "Unknown" : value.toFixed(2);
}

export function analysisFieldValues(analysis: AnalysisView | null): Record<string, string> {
  return {
    topic: analysis?.topic?.value ?? "",
    openingMove: analysis?.openingMove?.value ?? "",
    hookMechanism: analysis?.hookMechanism?.value ?? "",
    hook: analysis?.hook?.value ?? "",
    structure: analysis?.structure?.value ?? "",
    cta: analysis?.cta?.value ?? "",
    segmentRole: analysis?.segments?.map((segment) => segment.role ?? "").join(" ") ?? "",
  };
}

/** The lowercase text the search reads: advertiser, copy, headline, transcript and the whole analysis. */
export function researchCorpus(ad: Pick<ResearchAdRow, "advertiser" | "copy" | "headline" | "transcript">, analysis: AnalysisView | null): string {
  return `${ad.advertiser} ${ad.copy} ${ad.headline} ${ad.transcript} ${JSON.stringify(analysis ?? {})}`.toLowerCase();
}

/** An empty query matches everything. Otherwise the query is trimmed and compared case-insensitively, as before. */
export function searchMatches(corpus: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || corpus.includes(needle);
}

export function sourceKeyOf(_ad: ResearchAdRow): typeof META_SOURCE_KEY {
  return META_SOURCE_KEY;
}

export type ResearchFilters = {
  search: string;
  advertiser: string;
  source: "all" | typeof META_SOURCE_KEY;
  state: "all" | ResearchState;
  topic: string;
  field: string;
  minimumConfidence: number;
  capturedFrom: Date | null;
  capturedTo: Date | null;
  minimumDurationSeconds: number | null;
  maximumDurationSeconds: number | null;
};

export const DEFAULT_RESEARCH_FILTERS: ResearchFilters = {
  search: "",
  advertiser: "",
  source: "all",
  state: "all",
  topic: "all",
  field: "all",
  minimumConfidence: 0,
  capturedFrom: null,
  capturedTo: null,
  minimumDurationSeconds: null,
  maximumDurationSeconds: null,
};

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

/** One predicate for every filter. Each rule matches the filter behaviour the screen had before, with two additions: an ad with no capture date fails a date filter, and an ad with no analysis keeps its place in the confidence filter. */
export function matchesResearchFilters(ad: ResearchAdRow, filters: ResearchFilters): boolean {
  const analysis = parseAnalysis(ad.analysis);
  const values = analysisFieldValues(analysis);
  if (!searchMatches(researchCorpus(ad, analysis), filters.search)) return false;
  if (filters.advertiser.trim() && !ad.advertiser.toLowerCase().includes(filters.advertiser.trim().toLowerCase())) return false;
  if (filters.source !== "all" && sourceKeyOf(ad) !== filters.source) return false;
  if (filters.state !== "all" && researchAdState(ad) !== filters.state) return false;
  if (filters.topic !== "all" && (analysis?.topic?.value ?? "").trim() !== filters.topic) return false;
  if (filters.field !== "all" && !(values[filters.field] ?? "").trim()) return false;
  if (filters.capturedFrom || filters.capturedTo) {
    const captured = Date.parse(ad.capturedAt);
    if (!Number.isFinite(captured)) return false;
    if (filters.capturedFrom && captured < startOfDay(filters.capturedFrom)) return false;
    if (filters.capturedTo && captured > endOfDay(filters.capturedTo)) return false;
  }
  if (filters.minimumDurationSeconds !== null && (!ad.durationMs || ad.durationMs < filters.minimumDurationSeconds * 1000)) return false;
  if (filters.maximumDurationSeconds !== null && (!ad.durationMs || ad.durationMs > filters.maximumDurationSeconds * 1000)) return false;
  return analysis === null || ad.confidence >= filters.minimumConfidence;
}

export function filterResearchAds(ads: readonly ResearchAdRow[], filters: ResearchFilters): ResearchAdRow[] {
  return ads.filter((ad) => matchesResearchFilters(ad, filters));
}

export function topicOptions(ads: readonly ResearchAdRow[]): string[] {
  const topics = new Set<string>();
  for (const ad of ads) {
    const topic = (parseAnalysis(ad.analysis)?.topic?.value ?? "").trim();
    if (topic) topics.add(topic);
  }
  return [...topics].sort((left, right) => left.localeCompare(right));
}

export function activeFilterCount(filters: ResearchFilters): number {
  return [
    filters.search.trim() !== "",
    filters.advertiser.trim() !== "",
    filters.source !== "all",
    filters.state !== "all",
    filters.topic !== "all",
    filters.field !== "all",
    filters.minimumConfidence > 0,
    filters.capturedFrom !== null || filters.capturedTo !== null,
    filters.minimumDurationSeconds !== null,
    filters.maximumDurationSeconds !== null,
  ].filter(Boolean).length;
}

/** Parses a typed duration. Blank or non-numeric input is no limit, never zero. */
export function parseSeconds(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Counts across the loaded ads. These are not per run: research_ads do not carry a run id in the market response. */
export function stageCounts(ads: readonly ResearchAdRow[]) {
  return {
    total: ads.length,
    mediaStored: ads.filter((ad) => ad.mediaStatus === "stored").length,
    transcribed: ads.filter((ad) => ad.transcriptStatus === "transcribed").length,
    analysed: ads.filter((ad) => ad.analysisStatus === "analyzed" || ad.analysisStatus === "review").length,
    failed: ads.filter((ad) => ad.mediaStatus === "failed" || ad.transcriptStatus === "failed" || ad.analysisStatus === "failed").length,
  };
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  collecting: "Collecting",
  succeeded: "Succeeded",
  NOT_CONNECTED: "Not connected",
  retry: "Retrying",
  failed: "Failed",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? (status.trim() || "Unknown");
}

export function isActiveRun(run: Pick<ResearchRunRow, "status">): boolean {
  return run.status === "queued" || run.status === "collecting";
}

export function isFailedRun(run: Pick<ResearchRunRow, "status" | "error">): boolean {
  return run.status === "failed" || run.status === "retry" || run.status === "NOT_CONNECTED" || run.error.trim() !== "";
}

/** The source video's state, in words. The screen cannot play stored media yet, so it says that. */
export function mediaNote(ad: Pick<ResearchAdRow, "mediaStatus" | "error">): string {
  switch (ad.mediaStatus) {
    case "stored":
      return "Source video is stored. This view cannot play it yet.";
    case "pending":
      return "Source video has not been stored yet.";
    case "unavailable":
      return "No public downloadable video was found for this ad, so it was not analysed.";
    case "failed":
      return ad.error ? `Storing the source video failed: ${ad.error}` : "Storing the source video failed.";
    default:
      return "Media status is not stored.";
  }
}

/** Ads carry the Ad Library start date when one exists, and the capture time otherwise. Last seen is the capture time. */
export function firstSeen(ad: Pick<ResearchAdRow, "publishedAt" | "capturedAt">): string {
  return ad.publishedAt ?? ad.capturedAt;
}

export function formatDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : "Unknown";
}

export function formatDuration(durationMs: number): string {
  return durationMs > 0 ? `${(durationMs / 1000).toFixed(1)} sec` : "Unknown";
}

const STATUS_WORDS: Record<string, string> = {
  stored: "stored",
  pending: "pending",
  unavailable: "unavailable",
  failed: "failed",
  transcribed: "transcribed",
  no_speech: "no speech",
  NOT_CONNECTED: "not connected",
  analyzed: "analysed",
  review: "needs review",
};

/** Stored status words, in plain English. Unknown codes are shown as written, with underscores spaced out. */
export function humanStatus(status: string): string {
  return STATUS_WORDS[status] ?? (status.trim().replaceAll("_", " ").toLowerCase() || "unknown");
}

/** m:ss.s for a transcript timestamp in milliseconds. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

/** Advertiser links only open http or https. Anything else is shown as text. */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
