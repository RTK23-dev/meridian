// A reviewer's decision on a rendered repurposed variation. It is the same kind of decision as the approval of a delivered video
// (approval.ts): an approval is gated by the rights records that cover the files the video was made from (governance.ts), and a rejection
// needs its reason. A decision names the variation's run, its key and the rendered video it was made on, so a re-render starts undecided.
// Recording a decision does not publish anything: publishing a repurposed variation is not connected in this release.

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { approvalProblem, isApprovalDecision, type ApprovalDecision } from "./approval.ts";
import { coveringRightsRecordIds, rightsGate } from "./governance.ts";
import { rightsRecordsOf, sessionAccess, storedFilesOf, todayIso } from "./service.ts";

export type RepurposeReviewState = { status: "not_decided" } | { status: ApprovalDecision; decidedAt: string; actorId: string; reason: string };

type ReviewedVariant = {
  variant_key: string;
  decision: ApprovalDecision | null;
  reason: string | null;
  actor_id: string | null;
  created_at: unknown;
};

/** The latest decision on each rendered variation of a run, read for the video it was made on. Admins only. */
export async function repurposeReviewsOf(sql: Sql, userId: string, input: { sessionId: string; runId: string }): Promise<Record<string, RepurposeReviewState>> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const rows = await sql<ReviewedVariant>`
    select v.variant_key, rv.decision, rv.reason, rv.actor_id, rv.created_at
    from content_factory_repurpose_variants v
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    left join lateral (
      select decision, reason, actor_id, created_at from content_factory_repurpose_reviews x
      where x.organization_id = v.organization_id and x.run_id = v.run_id and x.variant_key = v.variant_key
        and x.rendered_artifact_id = v.rendered_artifact_id
      order by x.created_at desc, x.id desc limit 1
    ) rv on true
    where v.organization_id = ${row.organization_id} and r.session_id = ${row.id} and v.run_id = ${input.runId}
      and v.status = 'rendered' and v.rendered_artifact_id is not null
  `;
  const states: Record<string, RepurposeReviewState> = {};
  for (const item of rows) {
    states[item.variant_key] =
      item.decision === null || item.decision === undefined
        ? { status: "not_decided" }
        : { status: item.decision, decidedAt: new Date(item.created_at as string | Date).toISOString(), actorId: item.actor_id ?? "", reason: item.reason ?? "" };
  }
  return states;
}

/**
 * Records a decision on one rendered variation. Admins only. The session row and the variation row are locked, so two decisions cannot both
 * pass the checks. An approval is blocked until every file the video was made from has a valid rights record, as a master's approval is.
 */
export async function recordRepurposeReview(
  sql: Sql,
  userId: string,
  input: { sessionId: string; runId: string; variantKey: string; decision: string; reason: string },
): Promise<void> {
  const problem = approvalProblem({ decision: input.decision, reason: input.reason });
  if (problem) throw new Error(problem);
  if (!isApprovalDecision(input.decision)) throw new Error("Choose approve or reject.");
  const decision: ApprovalDecision = input.decision;
  const reason = input.reason.trim();
  await withTransaction(sql, async (tx) => {
    const row = await sessionAccess(tx, userId, input.sessionId);
    await tx`select id from content_factory_sessions where id = ${row.id} for update`;
    const variants = await tx<{ status: string; rendered_artifact_id: string | null }>`
      select v.status, v.rendered_artifact_id
      from content_factory_repurpose_variants v
      join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
      where v.organization_id = ${row.organization_id} and r.session_id = ${row.id} and v.run_id = ${input.runId} and v.variant_key = ${input.variantKey}
      for update of v
    `;
    const variant = variants[0];
    if (variant === undefined || variant.status !== "rendered" || variant.rendered_artifact_id === null) {
      throw new Error("This variation is not rendered, so there is nothing to approve or reject.");
    }
    const latest = await tx<{ decision: ApprovalDecision }>`
      select decision from content_factory_repurpose_reviews
      where organization_id = ${row.organization_id} and run_id = ${input.runId} and variant_key = ${input.variantKey}
        and rendered_artifact_id = ${variant.rendered_artifact_id}
      order by created_at desc, id desc limit 1
    `;
    if (latest[0]?.decision === decision) throw new Error(`This variation is already ${decision}.`);

    // A rejection is never gated: a video that should not go out is always allowed to be turned down.
    let rightsRecordIds: string[] = [];
    if (decision === "approved") {
      const files = await storedFilesOf(tx, row.organization_id, row.id);
      const records = await rightsRecordsOf(tx, row.organization_id, row.brand_id);
      const gate = rightsGate(files, records, todayIso());
      if (!gate.ok) {
        throw new Error(`The approval is blocked: no valid rights record covers ${gate.missing.join(", ")}. Add the rights under Content standards, then approve.`);
      }
      rightsRecordIds = coveringRightsRecordIds(files, records, todayIso());
    }
    await tx`
      insert into content_factory_repurpose_reviews
        (id, organization_id, run_id, variant_key, rendered_artifact_id, decision, reason, rights_record_ids, actor_id)
      values (${randomUUID()}, ${row.organization_id}, ${input.runId}, ${input.variantKey}, ${variant.rendered_artifact_id},
        ${decision}, ${reason}, ${JSON.stringify(rightsRecordIds)}, ${userId})
    `;
  });
}
