// Cost of the delivered videos (Video Engine Bible 4.4 Manifest.cost, 14.2, 14.3). A settled ledger row is put in one of four
// buckets, the ones budgets.ts names for the manifest: brain (the Claude calls), generation (the shots), render, and other (speech
// and media). Each row is also attributed to one video: a render belongs to the video whose composition it paid for, and every other
// row belongs to the master, because the variants reuse the master's takes and voice. So the manifests of the delivered videos
// together hold every paid call of the request, once. Pure.

import { budgets } from "../config/budgets.ts";
import { EngineError, roundUsd, sumUsd, type ClaudeRole, type CostBreakdown } from "../contracts/index.ts";
import type { SettledRow } from "./ledger.ts";

export type CostCategory = "brain" | "generation" | "render" | "other";

/** The bucket of one ledger row. A row with a Claude role is a brain call, whatever its stage label. */
export function categoryOf(row: { stage: string; role?: ClaudeRole }): CostCategory {
  if (row.role !== undefined) return "brain";
  if (row.stage === budgets.fixedStages.claudeRoles || row.stage === budgets.fixedStages.critic) return "brain";
  if (row.stage === budgets.fixedStages.render) return "render";
  if (row.stage === "produce_shot") return "generation";
  return "other";
}

/** The cost breakdown of some rows. total is the exact sum of the four buckets (Manifest v2 refines it). */
export function costOf(rows: readonly SettledRow[]): CostBreakdown {
  const buckets: Record<CostCategory, number[]> = { brain: [], generation: [], render: [], other: [] };
  for (const row of rows) buckets[categoryOf(row)].push(row.actualUsd);
  const brain = sumUsd(buckets.brain);
  const generation = sumUsd(buckets.generation);
  const render = sumUsd(buckets.render);
  const other = sumUsd(buckets.other);
  return { brain, generation, render, other, total: sumUsd([brain, generation, render, other]) };
}

/** A rendered video the attribution can name: its id, its composition's hash (the render's ledger key) and whether it delivers. */
export type RenderLink = { videoId: string; idempotencyKey: string };

/**
 * Which video each row is attributed to. A render row goes to the video whose render has its idempotency key (the composition hash,
 * Bible 6.11), when that video is delivered. Every other row, and a render no delivered video claims, goes to the master, so the
 * sum over the delivered videos is the sum over all rows.
 */
export function attributeRows(
  rows: readonly SettledRow[],
  input: { masterVideoId: string; renders: readonly RenderLink[]; deliveredVariantVideoIds: ReadonlySet<string> },
): Map<string, SettledRow[]> {
  const byVideo = new Map<string, SettledRow[]>([[input.masterVideoId, []]]);
  for (const row of rows) {
    let videoId = input.masterVideoId;
    if (row.stage === budgets.fixedStages.render) {
      const link = input.renders.find((candidate) => candidate.idempotencyKey === row.idempotencyKey);
      if (link !== undefined && input.deliveredVariantVideoIds.has(link.videoId)) videoId = link.videoId;
    }
    const list = byVideo.get(videoId) ?? [];
    list.push(row);
    byVideo.set(videoId, list);
  }
  return byVideo;
}

/** Calls that never returned an answer (a pending journal row). Their cost is held as the estimate, and the delivery event counts them. */
export function unansweredCount(entries: readonly { status: string }[]): number {
  return entries.filter((entry) => entry.status === "pending").length;
}

/** The sum of the rows, as an exact USD amount. */
export function totalOf(rows: readonly SettledRow[]): number {
  if (rows.some((row) => !Number.isFinite(row.actualUsd) || row.actualUsd < 0)) {
    throw new EngineError("internal", "a ledger row has no usable actual cost, so the total cannot be read", { stage: "deliver" });
  }
  return roundUsd(sumUsd(rows.map((row) => row.actualUsd)));
}
