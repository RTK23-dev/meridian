// The orchestrator's plan store (migration 0108): a plan per organization, and its run events in order. Every read and write is scoped to
// the organization. A plan that belongs to another organization is reported as not found, never as forbidden, so ids do not leak.
// JSON is written as text and read back as text, the way the other engine stores do.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { NodeEvent, OrchestratorPlan } from "./contracts.ts";
import { orchestratorPlanSchema } from "./contracts.ts";

export const PLAN_STATUSES = ["draft", "planning", "refused", "ready", "running", "paused", "incomplete", "complete"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type StoredPlan = {
  id: string;
  organizationId: string;
  title: string;
  brief: unknown;
  orchestratorModel: string;
  budgetUsd: number;
  status: PlanStatus;
  plan: OrchestratorPlan | null;
  reasons: string[];
  catalogReadAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredEvent = NodeEvent & { seq: number; at: string };

type Row = Record<string, unknown>;

function planOf(row: Row): StoredPlan {
  const planText = row.plan_json === null || row.plan_json === undefined ? null : String(row.plan_json);
  const plan = planText === null ? null : orchestratorPlanSchema.parse(JSON.parse(planText));
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    title: String(row.title),
    brief: JSON.parse(String(row.brief_json)),
    orchestratorModel: String(row.orchestrator_model),
    budgetUsd: Number(row.budget_usd),
    status: String(row.status) as PlanStatus,
    plan,
    reasons: JSON.parse(String(row.reasons_json)) as string[],
    catalogReadAt: row.catalog_read_at === null || row.catalog_read_at === undefined ? null : new Date(String(row.catalog_read_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/** A new draft: the user has chosen the orchestrating model and the brief, and nothing has been planned yet. */
export async function createPlanDraft(
  sql: Sql,
  input: { id: string; organizationId: string; title: string; brief: unknown; orchestratorModel: string; budgetUsd: number },
): Promise<StoredPlan> {
  await sql`
    insert into orchestrator_plans (id, organization_id, title, brief, orchestrator_model, budget_usd, status)
    values (${input.id}, ${input.organizationId}, ${input.title}, ${JSON.stringify(input.brief)}::jsonb, ${input.orchestratorModel}, ${input.budgetUsd}, 'draft')
  `;
  const found = await getPlan(sql, input.organizationId, input.id);
  if (found === null) throw new Error("the plan was not stored");
  return found;
}

/** Record the outcome of planning: ready with a checked plan, or refused with the reasons. */
export async function recordPlanOutcome(
  sql: Sql,
  input: { id: string; organizationId: string; plan: OrchestratorPlan | null; reasons: string[]; catalogReadAt: string | null },
): Promise<StoredPlan | null> {
  const status: PlanStatus = input.plan === null ? "refused" : "ready";
  const rows = (await sql`
    update orchestrator_plans
    set status = ${status},
        plan = ${input.plan === null ? null : JSON.stringify(input.plan)}::jsonb,
        reasons = ${JSON.stringify(input.reasons)}::jsonb,
        catalog_read_at = ${input.catalogReadAt},
        updated_at = now()
    where id = ${input.id} and organization_id = ${input.organizationId}
    returning id
  `) as Row[];
  if (rows.length === 0) return null;
  return getPlan(sql, input.organizationId, input.id);
}

export async function setPlanStatus(sql: Sql, organizationId: string, id: string, status: PlanStatus): Promise<StoredPlan | null> {
  const rows = (await sql`
    update orchestrator_plans set status = ${status}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
    returning id
  `) as Row[];
  if (rows.length === 0) return null;
  return getPlan(sql, organizationId, id);
}

export async function getPlan(sql: Sql, organizationId: string, id: string): Promise<StoredPlan | null> {
  const rows = (await sql`
    select id, organization_id, title, brief::text as brief_json, orchestrator_model, budget_usd, status, plan::text as plan_json,
      reasons::text as reasons_json, catalog_read_at, created_at, updated_at
    from orchestrator_plans where id = ${id} and organization_id = ${organizationId}
  `) as Row[];
  const row = rows[0];
  return row === undefined ? null : planOf(row);
}

export async function listPlans(sql: Sql, organizationId: string, limit: number): Promise<StoredPlan[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = (await sql`
    select id, organization_id, title, brief::text as brief_json, orchestrator_model, budget_usd, status, plan::text as plan_json,
      reasons::text as reasons_json, catalog_read_at, created_at, updated_at
    from orchestrator_plans where organization_id = ${organizationId}
    order by created_at desc, id desc limit ${bounded}
  `) as Row[];
  return rows.map(planOf);
}

/** Append run events to a plan, in order. Returns false when the plan is not the organization's, and nothing is written. */
export async function appendPlanEvents(sql: Sql, organizationId: string, planId: string, events: NodeEvent[]): Promise<boolean> {
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return false;
  for (const event of events) {
    await sql`
      insert into orchestrator_plan_events (plan_id, seq, node_id, state, output_hash, cost_usd, reason)
      select ${planId}, coalesce(max(seq), 0) + 1, ${event.nodeId}, ${event.state}, ${event.outputHash}, ${event.costUsd}, ${event.reason}
      from orchestrator_plan_events where plan_id = ${planId}
    `;
  }
  return true;
}

/** The run's events after a sequence number, in order. Empty when the plan is not the organization's. */
export async function listPlanEvents(sql: Sql, organizationId: string, planId: string, afterSeq: number): Promise<StoredEvent[]> {
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return [];
  const rows = (await sql`
    select seq, node_id, state, output_hash, cost_usd, reason, at from orchestrator_plan_events
    where plan_id = ${planId} and seq > ${Math.max(0, Math.trunc(afterSeq))} order by seq asc
  `) as Row[];
  return rows.map((row) => ({
    seq: Number(row.seq),
    nodeId: String(row.node_id),
    state: String(row.state) as NodeEvent["state"],
    outputHash: row.output_hash === null || row.output_hash === undefined ? null : String(row.output_hash),
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    at: new Date(String(row.at)).toISOString(),
  }));
}

/** Replace a plan's checked plan (after an edit that the engine has checked). Returns null when the plan is not the organization's. */
export async function updatePlanJson(sql: Sql, organizationId: string, id: string, plan: OrchestratorPlan): Promise<StoredPlan | null> {
  const rows = (await sql`
    update orchestrator_plans set plan = ${JSON.stringify(plan)}::jsonb, status = 'ready', updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
    returning id
  `) as Row[];
  if (rows.length === 0) return null;
  return getPlan(sql, organizationId, id);
}

/** The stored step outputs of a plan, by cache key. Empty when the plan is not the organization's. */
export async function listStepOutputs(sql: Sql, organizationId: string, planId: string): Promise<Map<string, { outputHash: string; costUsd: number | null }>> {
  const out = new Map<string, { outputHash: string; costUsd: number | null }>();
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return out;
  const rows = (await sql`select cache_key, output_hash, cost_usd from orchestrator_step_outputs where plan_id = ${planId}`) as Row[];
  for (const row of rows) {
    out.set(String(row.cache_key), {
      outputHash: String(row.output_hash),
      costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    });
  }
  return out;
}

/** Store one step output under its cache key. Returns false when the plan is not the organization's. */
export async function putStepOutput(
  sql: Sql,
  organizationId: string,
  planId: string,
  cacheKey: string,
  output: { outputHash: string; costUsd: number | null },
): Promise<boolean> {
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return false;
  await sql`
    insert into orchestrator_step_outputs (plan_id, cache_key, output_hash, cost_usd)
    values (${planId}, ${cacheKey}, ${output.outputHash}, ${output.costUsd})
    on conflict (plan_id, cache_key) do nothing
  `;
  return true;
}
