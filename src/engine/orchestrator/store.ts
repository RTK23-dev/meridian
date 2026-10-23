// The orchestrator's plan store (migration 0108): a plan per organization, and its run events in order. Every read and write is scoped to
// the organization. A plan that belongs to another organization is reported as not found, never as forbidden, so ids do not leak.
// JSON is written as text and read back as text, the way the other engine stores do.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { NodeEvent, OrchestratorPlan } from "./contracts.ts";
import { orchestratorPlanSchema } from "./contracts.ts";
import { BUDGET_CATEGORIES, type BudgetCategory, type CategoryAmounts } from "./categories.ts";

export const PLAN_STATUSES = ["draft", "planning", "refused", "ready", "running", "paused", "incomplete", "complete"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type StoredPlan = {
  id: string;
  organizationId: string;
  title: string;
  brief: unknown;
  orchestratorModel: string;
  budgetUsd: number;
  /** The brand the plan was made for, or null for a plan with no brand (migration 0119). A plan with no brand uses the workspace set alone. */
  brandId: string | null;
  status: PlanStatus;
  plan: OrchestratorPlan | null;
  reasons: string[];
  catalogReadAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredEvent = NodeEvent & { seq: number; at: string };

/**
 * A step output as stored: its hash, its charged cost, its body (null when the step has no text) and its budget category (null for a step with
 * no model call). An output stored before categories existed has a null category; its plan has no category budgets, so none reads it.
 */
export type StoredStepOutput = { outputHash: string; costUsd: number | null; body: string | null; category: BudgetCategory | null };

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
    brandId: row.brand_id === null || row.brand_id === undefined ? null : String(row.brand_id),
    status: String(row.status) as PlanStatus,
    plan,
    reasons: JSON.parse(String(row.reasons_json)) as string[],
    catalogReadAt: row.catalog_read_at === null || row.catalog_read_at === undefined ? null : new Date(String(row.catalog_read_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/**
 * A new draft: the user has chosen the orchestrating model and the brief, and nothing has been planned yet. The brand is recorded when the
 * plan has one (migration 0119); a plan made without a brand stores null.
 */
export async function createPlanDraft(
  sql: Sql,
  input: { id: string; organizationId: string; title: string; brief: unknown; orchestratorModel: string; budgetUsd: number; brandId?: string | null },
): Promise<StoredPlan> {
  await sql`
    insert into orchestrator_plans (id, organization_id, title, brief, orchestrator_model, budget_usd, status, brand_id)
    values (${input.id}, ${input.organizationId}, ${input.title}, ${JSON.stringify(input.brief)}::jsonb, ${input.orchestratorModel}, ${input.budgetUsd}, 'draft', ${input.brandId ?? null})
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

/**
 * Claim a draft or a refused plan for planning. One conditional update, so two requests cannot both call the model: true only when this
 * call took the plan. False when the plan is not the organization's or is not in a state that can be planned.
 */
export async function claimForPlanning(sql: Sql, organizationId: string, planId: string): Promise<boolean> {
  const rows = (await sql`
    update orchestrator_plans set status = 'planning', updated_at = now()
    where id = ${planId} and organization_id = ${organizationId} and status in ('draft', 'refused')
    returning id
  `) as Row[];
  return rows.length > 0;
}

/**
 * Give a claimed plan back its previous status, but only while it is still planning: an outcome the call already stored is kept.
 * Used when planning throws, so the plan is never left in planning with nothing running.
 */
export async function releasePlanning(sql: Sql, organizationId: string, planId: string, to: PlanStatus): Promise<void> {
  await sql`
    update orchestrator_plans set status = ${to}, updated_at = now()
    where id = ${planId} and organization_id = ${organizationId} and status = 'planning'
  `;
}

export async function getPlan(sql: Sql, organizationId: string, id: string): Promise<StoredPlan | null> {
  const rows = (await sql`
    select id, organization_id, title, brief::text as brief_json, orchestrator_model, budget_usd, status, plan::text as plan_json,
      reasons::text as reasons_json, catalog_read_at, created_at, updated_at, brand_id
    from orchestrator_plans where id = ${id} and organization_id = ${organizationId}
  `) as Row[];
  const row = rows[0];
  return row === undefined ? null : planOf(row);
}

export async function listPlans(sql: Sql, organizationId: string, limit: number): Promise<StoredPlan[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = (await sql`
    select id, organization_id, title, brief::text as brief_json, orchestrator_model, budget_usd, status, plan::text as plan_json,
      reasons::text as reasons_json, catalog_read_at, created_at, updated_at, brand_id
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

/**
 * Replace a plan's checked plan (after an edit that the engine has checked). Returns null when the plan is not the organization's, or when
 * it is running: an edit never clears a run in progress, and nothing is written.
 */
export async function updatePlanJson(sql: Sql, organizationId: string, id: string, plan: OrchestratorPlan): Promise<StoredPlan | null> {
  const rows = (await sql`
    update orchestrator_plans set plan = ${JSON.stringify(plan)}::jsonb, status = 'ready', updated_at = now()
    where id = ${id} and organization_id = ${organizationId} and status <> 'running'
    returning id
  `) as Row[];
  if (rows.length === 0) return null;
  return getPlan(sql, organizationId, id);
}

/** The stored step outputs of a plan, by cache key. Empty when the plan is not the organization's. */
export async function listStepOutputs(sql: Sql, organizationId: string, planId: string): Promise<Map<string, StoredStepOutput>> {
  const out = new Map<string, StoredStepOutput>();
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return out;
  const rows = (await sql`select cache_key, output_hash, cost_usd, body, category from orchestrator_step_outputs where plan_id = ${planId}`) as Row[];
  for (const row of rows) {
    out.set(String(row.cache_key), {
      outputHash: String(row.output_hash),
      costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
      body: row.body === null || row.body === undefined ? null : String(row.body),
      category: row.category === null || row.category === undefined ? null : (String(row.category) as BudgetCategory),
    });
  }
  return out;
}

/** Store one step output under its cache key, with its body. Returns false when the plan is not the organization's. */
export async function putStepOutput(sql: Sql, organizationId: string, planId: string, cacheKey: string, output: StoredStepOutput): Promise<boolean> {
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return false;
  await sql`
    insert into orchestrator_step_outputs (plan_id, cache_key, output_hash, cost_usd, body, category)
    values (${planId}, ${cacheKey}, ${output.outputHash}, ${output.costUsd}, ${output.body}, ${output.category})
    on conflict (plan_id, cache_key) do nothing
  `;
  return true;
}

/**
 * What the plan's failed paid steps held. A paid step whose call threw keeps its estimate held (execute.ts), and the hold is recorded on
 * its failed event. Summed here, so a later run counts money that was held but produced no stored output. Zero when the plan is not the
 * organization's.
 */
export async function failedHoldsUsd(sql: Sql, organizationId: string, planId: string): Promise<number> {
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return 0;
  const rows = (await sql`
    select coalesce(sum(cost_usd), 0) as total from orchestrator_plan_events where plan_id = ${planId} and state = 'failed'
  `) as Row[];
  return Number(rows[0]?.total ?? 0);
}

/** The failed holds of a plan, summed by step. The same holds as failedHoldsUsd, kept apart so each takes its step's category. */
export async function failedHoldsByNode(sql: Sql, organizationId: string, planId: string): Promise<Map<string, number>> {
  const holds = new Map<string, number>();
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return holds;
  const rows = (await sql`
    select node_id, coalesce(sum(cost_usd), 0) as total from orchestrator_plan_events
    where plan_id = ${planId} and state = 'failed' group by node_id
  `) as Row[];
  for (const row of rows) holds.set(String(row.node_id), Number(row.total));
  return holds;
}

/** What the plan's stored outputs have cost, by category. An output with no category is in none (categories.ts). */
export async function outputsSpentByCategory(sql: Sql, organizationId: string, planId: string): Promise<CategoryAmounts> {
  const spent: CategoryAmounts = {};
  const owned = await getPlan(sql, organizationId, planId);
  if (owned === null) return spent;
  const rows = (await sql`
    select category, coalesce(sum(cost_usd), 0) as total from orchestrator_step_outputs
    where plan_id = ${planId} and category is not null group by category
  `) as Row[];
  for (const row of rows) {
    const category = BUDGET_CATEGORIES.find((name) => name === String(row.category));
    if (category !== undefined) spent[category] = Number(row.total);
  }
  return spent;
}
