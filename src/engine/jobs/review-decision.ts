// The decision on one engine review item (Video Engine Bible 12.5). A person accepts, chooses a take, rejects, changes the visual type or
// edits the prompt. Each decision does four things, in this order:
//
// 1. Reads the item and checks it is open. A decision on a resolved item is refused.
// 2. Acts on the request. A take escalation that the person accepts or chooses from is applied as the orchestrator's human_choice event,
//    with a dedupe key, so a retry applies it once. A sampled video's acceptance moves its format's sampling count (review/sampling.ts).
//    A reject, a change of visual type or a prompt edit does not move the orchestrator here: a change goes through the remake path
//    (remakeEngineShot and decideEngineShot in engine/api), which runs its own reservation.
// 3. Writes the item's gold labels, one event each (review/labels.ts): every decision is a labelled example of the checks the item showed,
//    and a check the item does not carry is listed as skipped, never labelled from a guess.
// 4. Resolves the item and records review.decided. The resolve is a conditional update, so two decisions on one item cannot both resolve it.
//
// Pure rules live in review/labels.ts and review/sampling.ts. This file only sequences the writes.

import { randomUUID } from "node:crypto";
import { EngineError } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { GATE_REVIEW_SCHEMA, TAKE_REVIEW_SCHEMA } from "../review/inbox.ts";
import { labelsFromGateDecision, labelsFromTakeDecision, reviewDecisionSchema, type ReviewDecision, type SkippedCheck } from "../review/labels.ts";
import type { GoldLabel } from "../review/gold.ts";
import { afterSampleDecision } from "../review/sampling.ts";
import { applyEngineEvent, transaction } from "./orchestrator-sql.ts";
import { sqlSamplingPorts, SAMPLE_REVIEW_SCHEMA } from "./sampling-store.ts";

export type ReviewDecisionInput = {
  organizationId: string;
  itemId: string;
  actorId: string;
  decision: ReviewDecision;
  now: string;
};

export type ReviewDecisionResult = {
  itemId: string;
  requestId: string;
  kind: string;
  action: ReviewDecision["action"];
  /** The gold labels written, one event each. */
  labels: number;
  skipped: SkippedCheck[];
  /** What the decision moved on the request: an orchestrator event, or the sampling count. Null when neither. */
  effect: "human_choice" | "sampling" | null;
};

function detailOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function labelsOf(detail: Record<string, unknown>, decision: ReviewDecision): { labels: GoldLabel[]; skipped: SkippedCheck[] } {
  if (detail.schema === TAKE_REVIEW_SCHEMA) return labelsFromTakeDecision(detail, decision);
  if (detail.schema === GATE_REVIEW_SCHEMA && (decision.action === "accept" || decision.action === "reject")) {
    return labelsFromGateDecision(detail, decision);
  }
  return { labels: [], skipped: [] };
}

/** Records one decision on an open review item. A refused decision changes nothing and throws the reason. */
export async function decideEngineReviewItem(sql: Sql, input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
  const parsed = reviewDecisionSchema.safeParse(input.decision);
  if (!parsed.success) throw new EngineError("invalid_input", "a decision needs an action and the reason it is made for");
  const decision = parsed.data;

  const rows = await sql<{ request_id: string; kind: string; status: string; detail: unknown }>`
    select request_id, kind, status, detail from engine_review_items
    where id = ${input.itemId} and organization_id = ${input.organizationId}
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new EngineError("not_found", "that review item is not in this workspace");
  if (row.status !== "open") throw new EngineError("conflict", "that review item is already resolved");
  const detail = detailOf(row.detail);

  let effect: ReviewDecisionResult["effect"] = null;
  if (row.kind === "sample") {
    if (detail.schema !== SAMPLE_REVIEW_SCHEMA || typeof detail.formatKey !== "string") {
      throw new EngineError("invalid_input", "a sampled review item names no format, so its decision cannot be counted");
    }
    effect = "sampling";
  } else if (detail.schema === TAKE_REVIEW_SCHEMA && (decision.action === "accept" || decision.action === "choose_take")) {
    if (decision.takeId === undefined) throw new EngineError("invalid_input", "accepting or choosing a take names the take");
    if (typeof detail.shotId !== "string") throw new EngineError("invalid_input", "the take review item names no shot");
    // The orchestrator refuses a choice its shot is not waiting for, so a refused choice leaves the item open.
    await applyEngineEvent(sql, {
      organizationId: input.organizationId,
      requestId: row.request_id,
      event: { type: "human_choice", shotId: detail.shotId, takeId: decision.takeId },
      dedupeKey: `review-choice:${input.itemId}`,
    });
    effect = "human_choice";
  }

  const outcome = labelsOf(detail, decision);
  const skipped: SkippedCheck[] = [...outcome.skipped];
  if (row.kind === "sample") {
    skipped.push({ subject: String(detail.videoId ?? input.itemId), check: "*", reason: "a sampled video's acceptance is counted; its checks are not labelled" });
  }
  const resolution = JSON.stringify({ action: decision.action, takeId: decision.takeId ?? null, reason: decision.reason, actorId: input.actorId });

  await transaction(sql, async (tx) => {
    const claimed = await tx<{ id: string }>`
      update engine_review_items set status = 'resolved', resolution = ${resolution}, resolved_at = ${input.now}
      where id = ${input.itemId} and organization_id = ${input.organizationId} and status = 'open'
      returning id
    `;
    if (claimed.length === 0) throw new EngineError("conflict", "that review item was resolved while this decision was made");

    for (const [index, label] of outcome.labels.entries()) {
      await tx`
        insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
        values (${randomUUID()}, ${input.organizationId}, ${row.request_id}, 'gold_label', 'check_take', ${String(detail.shotId ?? input.itemId)},
          '', ${`gold:${input.itemId}:${index}`}, ${JSON.stringify({ label, itemId: input.itemId, reason: decision.reason })})
        on conflict (organization_id, dedupe_key) do nothing
      `;
    }
    await tx`
      insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
      values (${randomUUID()}, ${input.organizationId}, ${row.request_id}, 'review.decided', 'review', ${input.itemId},
        '', ${`review-decided:${input.itemId}`}, ${JSON.stringify({ itemId: input.itemId, kind: row.kind, action: decision.action, actorId: input.actorId })})
      on conflict (organization_id, dedupe_key) do nothing
    `;

    if (row.kind === "sample") {
      const ports = sqlSamplingPorts(tx);
      const scope = { organizationId: input.organizationId, formatKey: String(detail.formatKey) };
      await ports.save(scope, afterSampleDecision(await ports.state(scope), decision.action));
    }
  });

  return {
    itemId: input.itemId,
    requestId: row.request_id,
    kind: row.kind,
    action: decision.action,
    labels: outcome.labels.length,
    skipped,
    effect,
  };
}
