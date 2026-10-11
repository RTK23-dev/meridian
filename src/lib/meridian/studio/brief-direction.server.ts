/**
 * What a rejected brief does to its opportunity's direction. A person accepts a direction before its brief is judged, so a
 * rejected brief must not leave the opportunity accepted or briefed on the strength of that brief. The reopen runs in the same
 * transaction as the rejection, so a failure leaves the approval and the brief exactly as they were before.
 */
import type { Sql } from "../learning/store.ts";

/**
 * Reopens the opportunity when none of its other briefs is still live. A brief is live while it is ready, awaiting review, or
 * used. Returns true when the opportunity was reopened. The direction row is append-only and is not changed: the reopen is
 * recorded as an audit row that names the rejected brief.
 */
export async function reopenDirectionAfterRejectedBrief(
  tx: Sql,
  input: { organizationId: string; brandId: string; opportunityId: string; briefId: string; actorId: string },
): Promise<boolean> {
  const live = await tx<{ id: string }>`
    select id from briefs
    where opportunity_id = ${input.opportunityId} and organization_id = ${input.organizationId} and id <> ${input.briefId}
      and status in ('ready', 'awaiting_review', 'used')
    limit 1
  `;
  if (live.length > 0) return false;
  const reopened = await tx<{ id: string }>`
    update opportunities set status = 'open'
    where id = ${input.opportunityId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and status in ('accepted', 'briefed')
    returning id
  `;
  if (reopened.length === 0) return false;
  await tx`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${globalThis.crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.actorId},
      'opportunity.direction.reopened', 'opportunity', ${input.opportunityId},
      ${JSON.stringify({ briefId: input.briefId, reason: "brief rejected" })}
    )
  `;
  return true;
}
