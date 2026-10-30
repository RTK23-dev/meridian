// A batch of videos (prompt 15). Each item is a Content Factory session with its own state. The state comes from the engine's own status of the
// item's request, or from a start the engine never took (a refusal, a budget stop). Nothing is shown as running, delivered or retried without
// that status. A batch has one budget and it is a hard limit: a start that would take the committed spend past it is refused, and the batch
// stops there, so the videos after it are not started. A retry is for one failed item; its siblings are not touched.

import type { EngineRequestStatus } from "../../../engine/api/index.ts";

export const BATCH_ITEM_STATES = ["ready", "queued", "running", "awaiting_review", "blocked", "failed", "retryable", "delivered"] as const;
export type BatchItemState = (typeof BATCH_ITEM_STATES)[number];

/** Attempts an item may make in all: its first and its retries. A session's revision counts from 0, so attempts are revision + 1. */
export const MAX_ITEM_ATTEMPTS = 3;

/** The most videos one batch holds. A batch is a set a person can read in one screen. */
export const MAX_BATCH_ITEMS = 20;

export type BatchItemFacts = {
  /** The session's status: 'draft' before a start, 'started' once the engine has taken the request. */
  sessionStatus: string;
  /** The session's revision: 0 for the first attempt, one more for each revision. */
  revision: number;
  /** The reasons the last start was refused, as the start stored them. Empty when the last start was taken, or none was tried. */
  lastRefusal: string[];
  /** The engine's status of the session's request. Null when the session has none yet. */
  engine: EngineRequestStatus | null;
};

export type BatchItemView = { state: BatchItemState; reason: string; retryable: boolean; attempts: number };

/** The state of one item, from its facts. A started item with no engine status is blocked, never shown as working. */
export function itemStateOf(facts: BatchItemFacts): BatchItemView {
  const attempts = facts.revision + 1;
  if (facts.sessionStatus !== "started") {
    if (facts.lastRefusal.length > 0) return { state: "blocked", reason: `Not started: ${facts.lastRefusal.join(" ")}`, retryable: false, attempts };
    return { state: "ready", reason: "Ready to start.", retryable: false, attempts };
  }
  const engine = facts.engine;
  if (engine === null) return { state: "blocked", reason: "The engine has no status for this video.", retryable: false, attempts };
  switch (engine.status) {
    case "queued":
      return { state: "queued", reason: "Queued. The engine has not picked it up yet.", retryable: false, attempts };
    case "running":
      return { state: "running", reason: `Working now${engine.stage ? ` (at ${engine.stage})` : ""}.`, retryable: false, attempts };
    case "needs_review":
      return {
        state: "awaiting_review",
        reason: `${engine.openItems} open review ${engine.openItems === 1 ? "item" : "items"}: ${engine.reason}`,
        retryable: false,
        attempts,
      };
    case "paused":
      return {
        state: "blocked",
        reason: engine.pauseKind === "budget" ? `Waiting on the budget: ${engine.reason}` : `A job failed for good: ${engine.reason}`,
        retryable: false,
        attempts,
      };
    case "delivered":
      return { state: "delivered", reason: "Delivered.", retryable: false, attempts };
    case "failed": {
      const why = engine.reasons.length > 0 ? engine.reasons.join(" ") : "The engine refused the video.";
      if (attempts < MAX_ITEM_ATTEMPTS) return { state: "retryable", reason: why, retryable: true, attempts };
      return { state: "failed", reason: `${why} No attempts are left for this item.`, retryable: false, attempts };
    }
  }
}

/** The spend an item has committed: the budgets of the items whose request the engine took. A refused or unstarted item commits nothing. */
export function committedUsd(items: readonly { started: boolean; budgetUsd: number | null }[]): number {
  return items.reduce((sum, item) => (item.started && item.budgetUsd !== null ? sum + item.budgetUsd : sum), 0);
}

/**
 * Whether one more item may start under the batch's budget. An item with no budget cannot be bounded, so it is refused while the batch has
 * a budget. A start that would take the committed spend past the budget is refused. The caller decides what that means: a batch start stops
 * there, and a retry is refused.
 */
export function fitsBatchBudget(input: { batchBudgetUsd: number; committedUsd: number; itemBudgetUsd: number | null }): { ok: true } | { ok: false; reason: string; overBudget: boolean } {
  if (input.itemBudgetUsd === null) {
    return { ok: false, reason: "This video has no budget set, so the batch cannot bound its spend. Set a budget on the video.", overBudget: false };
  }
  const after = input.committedUsd + input.itemBudgetUsd;
  if (after > input.batchBudgetUsd + 1e-9) {
    return {
      ok: false,
      reason: `Starting this video would take the batch past its budget of $${input.batchBudgetUsd.toFixed(2)} (committed $${input.committedUsd.toFixed(2)}).`,
      overBudget: true,
    };
  }
  return { ok: true };
}

export type BatchRowForExport = { position: number; title: string; angle: string | null; state: BatchItemState; reason: string; budgetUsd: number | null; attempts: number };

/** Counts by state, only for states that occur, in the order the states are listed. */
export function stateCounts(items: ReadonlyArray<{ state: BatchItemState }>): Array<{ state: BatchItemState; count: number }> {
  return BATCH_ITEM_STATES.map((state) => ({ state, count: items.filter((item) => item.state === state).length })).filter((entry) => entry.count > 0);
}

/** One CSV cell. A cell that starts like a formula is prefixed so a spreadsheet shows it as text. Quotes are doubled. */
export function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The batch as a spreadsheet: one row per video with the state the engine reports, the reason and the budget. It lists what is recorded and
 * nothing else; it holds no video file and no link, and a video that has not been delivered is not shown as finished.
 */
export function batchSummaryCsv(batch: { title: string; budgetUsd: number }, rows: readonly BatchRowForExport[]): string {
  const header = ["Batch", "Position", "Video", "Angle", "State", "Reason", "Budget (USD)", "Attempts"].map(csvCell).join(",");
  const lines = rows.map((row) =>
    [batch.title, row.position + 1, row.title, row.angle, row.state, row.reason, row.budgetUsd === null ? null : row.budgetUsd.toFixed(2), row.attempts].map(csvCell).join(","),
  );
  return `${[header, ...lines].join("\r\n")}\r\n`;
}

export type BatchForManifest = {
  id: string;
  title: string;
  budgetUsd: number;
  committedUsd: number;
  demo: boolean;
  items: ReadonlyArray<{
    position: number; title: string; angle: string | null; state: BatchItemState; reason: string; budgetUsd: number | null; attempts: number;
    approval: "approved" | "rejected" | "not_decided" | null; engineRequestId: string | null; manifestId: string | null; demo: boolean;
  }>;
};

/**
 * The batch's manifest: what is recorded for each video, as JSON. It lists ids and states. It holds no video file and no link, because the
 * files are read per video from its own screen. A demo batch says so at the top and on each video, and a video that is not delivered has no manifest id.
 */
export function batchManifestJson(batch: BatchForManifest, generatedAt: string): string {
  return `${JSON.stringify({
    kind: "meridian.batch-manifest",
    version: 1,
    generatedAt,
    demo: batch.demo,
    notice: batch.demo
      ? "DEMO: fixture data. No video was rendered and no provider was called. Nothing here is a real result."
      : "Lists what Meridian recorded for each video. It holds no video files. Open a video to read its delivered file.",
    batch: { id: batch.id, title: batch.title, budgetUsd: batch.budgetUsd, committedUsd: batch.committedUsd },
    videos: batch.items.map((item) => ({
      position: item.position + 1,
      title: item.title,
      angle: item.angle,
      state: item.state,
      reason: item.reason,
      approval: item.approval,
      budgetUsd: item.budgetUsd,
      attempts: item.attempts,
      engineRequestId: item.engineRequestId,
      manifestId: item.manifestId,
      demo: item.demo,
    })),
  }, null, 2)}\n`;
}
