/**
 * The one place the screens read user-facing words from: status labels, provider names, sentences for server codes, plain
 * error sentences, decision wording and the screen copy changed in the plain-language pass.
 *
 * Server values are never changed here. Codes such as NOT_CONNECTED, HYPIT_NOT_CONNECTED, AUTO_APPROVE and "test:image"
 * stay as the server sends them. This module only maps them to words for a person. It imports nothing, so the same rules
 * run under `node --experimental-strip-types` and in the browser.
 */

const STATUS_LABELS: Record<string, string> = {
  not_connected: "Not connected",
  in_review: "Needs review",
  dead: "Dead letter",
  retrying: "Retrying",
  succeeded: "Succeeded",
  failed: "Failed",
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  connected: "Connected",
  disconnected: "Disconnected",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  pending: "Pending",
  proposed: "Proposed",
  complete: "Complete",
  completed: "Complete",
};

const PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google: "Google Ads",
  ad_library: "Meta Ad Library",
  openrouter: "OpenRouter",
  nano_banana: "Google Nano Banana",
  hypit: "Hypit video",
  "test:image": "Test image",
  "test:video": "Test video fixture",
  "test:publisher": "Test publisher",
  "google:nano-banana": "Google Nano Banana",
};

export function statusLabel(status: string): string {
  const normalized = status.trim().toLowerCase().replaceAll("-", "_");
  if (STATUS_LABELS[normalized]) return STATUS_LABELS[normalized];
  return normalized.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()) || "Unknown";
}

export function providerLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_LABELS[normalized] ?? normalized.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

/**
 * Server codes that name a missing connection, with the sentence a person reads. Each sentence says what is missing and where
 * to fix it. Order matters: a longer code that contains a shorter one must come first.
 */
const SERVER_CODE_MESSAGES: ReadonlyArray<readonly [code: string, message: string]> = [
  ["HYPIT_NOT_CONNECTED", "Video engine not connected. Set up Hypit in Integrations."],
  ["NOT_CONNECTED", "Not connected. Connect it in Settings or Integrations."],
];

/** The sentence for a known server code found in a message, or null when the message names none. */
export function serverCodeMessage(text: string): string | null {
  for (const [code, message] of SERVER_CODE_MESSAGES) {
    if (text.includes(code)) return message;
  }
  return null;
}

export type PlainError = {
  /** The sentence shown above the disclosure. It never repeats the raw text. */
  message: string;
  /** The raw server or runtime text. It is shown only under a Details disclosure, and is empty when there was none. */
  raw: string;
};

const UNREACHABLE = "Meridian could not be reached. Check your connection and try again.";
const GENERIC = "The request did not finish. Try again.";
const GENERIC_WITH_DETAILS = "The request did not finish. Try again. Open Details for the exact message.";
const NETWORK_TEXT = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

/**
 * A raw error as one plain sentence, with the raw text kept for a Details disclosure. A known server code gets a fixed
 * sentence, a network failure gets the unreachable sentence, and anything else gets the generic one. Unknown text is never
 * shown above the disclosure.
 */
export function plainError(error: unknown): PlainError {
  const raw = rawErrorText(error).trim();
  const known = serverCodeMessage(raw);
  if (known) return { message: known, raw };
  if (NETWORK_TEXT.test(raw)) return { message: UNREACHABLE, raw };
  return { message: raw ? GENERIC_WITH_DETAILS : GENERIC, raw };
}

function rawErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return "";
}

/** A 0 to 1 value as a whole percentage, or "unknown". A missing or non-finite value is never shown as 0%. */
export function percentOrUnknown(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "unknown";
}

const DECISION_OUTCOMES: Readonly<Partial<Record<string, string>>> = {
  AUTO_APPROVE: "Approved",
  HUMAN_REVIEW: "Needs a person",
  REJECT: "Rejected",
};

/** The decision the engine returned, in words. An empty value means no decision is stored yet. An unlisted code is unknown. */
export function decisionOutcome(decision: string): string {
  if (!decision) return "No decision yet";
  return DECISION_OUTCOMES[decision] ?? "Unknown decision";
}

/**
 * One line for the decision engine, such as "Decision engine: approved (probability 82%)". The number is the decision
 * probability, not the confidence, so it is labelled as one. With no decision there is no probability to show.
 */
export function decisionEngineLine(input: { decision: string; probability: unknown }): string {
  const outcome = decisionOutcome(input.decision).toLowerCase();
  if (!input.decision) return `Decision engine: ${outcome}`;
  return `Decision engine: ${outcome} (probability ${percentOrUnknown(input.probability)})`;
}

/** The label and tooltip for an idea that no stored data backs yet. Shown as a badge wherever such an idea appears. */
export const IDEA_TO_TEST = {
  badge: "Idea to test",
  tooltip: "Not backed by stored data yet. It is a starting idea, not a finding. Test it before you rely on it.",
} as const;

/** Screen copy changed in the plain-language pass. Each entry is what a person reads. Server values stay in the data. */
export const copy = {
  opportunities: {
    rankAction: "Rank opportunities",
    rankingAction: "Ranking…",
    intro: "Each card is ranked from stored evidence. A hypothesis is not a market finding. Ranking replaces open cards. Accepted work is kept.",
    rankedNote: (count: number) => `${count} ${count === 1 ? "candidate" : "candidates"} ranked. Starting ideas stay labelled as ideas, not findings. An angle is added only when stored observations or a learned pattern contain it.`,
    empty: "Nothing is ranked yet. Ranking uses the brand brain, stored observations, and learned patterns. It does not invent competitors.",
    decisionNotYet: "No decision yet. No probability is shown until the decision engine returns one.",
  },
  learning: {
    noPattern: "Not enough results yet to spot a pattern. Patterns appear after a few ads have run.",
    patternRule: "The engine stores a pattern only when the evidence is decisive. Its chance of beating the brand baseline must be at least 80% or at most 20%, and the false-discovery rate across tested patterns must be 15% or less.",
    noPatternStored: "No pattern was stored yet. Not enough results support one. Queued learning jobs for this brand are still blocked. Nothing was invented.",
    patternsStored: (count: number) => `${count} ${count === 1 ? "pattern" : "patterns"} stored. Queued learning jobs were drained. Rank opportunities again to use them.`,
    noTestPublication: "No test publication is recorded for this brand yet.",
    testPublication: (id: string) => `Test publication · publisher ID ${id}`,
    startingEstimates: "Sync to JEV Brain updates the starting estimates from these rows.",
  },
  studio: {
    publisherId: "Publisher ID",
    copyPublisherId: "publisher ID",
  },
} as const;
