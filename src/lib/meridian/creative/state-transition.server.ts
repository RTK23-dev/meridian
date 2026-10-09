import type { Sql } from "../learning/store.ts";
import { transitionCreativePlanState, type CreativePlanState } from "./state-machine.ts";

/** Atomically transitions a tenant-scoped plan and appends its audit event. */
export async function transitionCreativePlan(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    planId: string;
    actorId: string;
    target: CreativePlanState;
    reason?: string;
  },
): Promise<{ status: CreativePlanState; alreadyInState: boolean }> {
  const rows = await sql<{ status: CreativePlanState }>`
    select status from creative_plans
    where id = ${input.planId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  const current = rows[0]?.status;
  if (!current) throw new Error("Creative plan not found.");
  const transition = transitionCreativePlanState(current, input.target);
  if (!transition.success) throw new Error(transition.error || "Creative plan transition is not allowed.");
  if (transition.alreadyInState) return { status: current, alreadyInState: true };

  const changed = await sql<{ status: CreativePlanState }>`
    with updated as (
      update creative_plans
      set status = ${input.target},
          approved_by = case when ${input.target} = 'approved' then ${input.actorId} else approved_by end,
          approved_at = case when ${input.target} = 'approved' then now() else approved_at end,
          updated_at = now()
      where id = ${input.planId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
        and status = ${current}
      returning id, organization_id, brand_id, status
    ), audit as (
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      select ${globalThis.crypto.randomUUID()}, organization_id, brand_id, ${input.actorId},
        ${`creative_plan.${input.target}`}, 'creative_plan', id,
        ${JSON.stringify({ previousStatus: current, newStatus: input.target, reason: input.reason || null })}::jsonb
      from updated
      returning id
    )
    select status from updated
  `;
  if (!changed[0]) throw new Error("Creative plan changed concurrently; reload it before continuing.");
  return { status: changed[0].status, alreadyInState: false };
}
