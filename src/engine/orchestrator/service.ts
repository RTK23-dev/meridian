// Plans a stored draft: the user's chosen model writes the plan, through the Claude client, on a budget hold of its own. The steps are:
// 1. The draft's brief must match its contract, and the chosen model must be a live text model with a per-token price. Otherwise no hold
//    is taken and no call is made, and the plan is refused with the reason.
// 2. The call's estimate (the role's tokens at the model's live price, rounded up) must fit the plan's budget. The hold is taken on the
//    ledger, under the plan's own request id, before the call.
// 3. The call (planWithRole) is journaled and budgeted like every role call. Its answer is checked against the live catalog.
// 4. The outcome is stored: ready with the checked plan, or refused with the reasons.
//
// The catalog and the gateway are passed in. In production the catalog is read through the gateway; without a connected key it is
// NOT_CONNECTED and nothing here is called.

import { estimateFromPriceUsd } from "../claude/rates.ts";
import { ORCHESTRATOR_PLAN_ESTIMATE_TOKENS, orchestratorBriefSchema } from "../claude/roles/orchestrator_plan.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import type { RoleDeps } from "../claude/client.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import { sqlRoleCallJournal } from "../jobs/role-call-store.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { OrchestratorPlan } from "./contracts.ts";
import { planWithRole, type PlannerBrief } from "./planner.ts";
import { getPlan, recordPlanOutcome, setPlanStatus, type StoredPlan } from "./store.ts";

export type PlanScope = {
  sql: Sql;
  organizationId: string;
  gateway: Gateway;
  catalog: Map<string, CatalogEntry>;
  /** When the catalog was read. It is stored with the plan. */
  catalogReadAt: string | null;
  /** The clock, as an ISO time. */
  now: () => string;
  /** Mints the request and reservation ids. Tests pass fixed ids; production passes none. */
  mint?: { request: () => string; reservation: () => string };
};

export type PlanDraftOutcome =
  | { status: "not_found" }
  | { status: "not_planned"; reasons: string[]; stored: StoredPlan }
  | { status: "ready"; stored: StoredPlan; plan: OrchestratorPlan }
  | { status: "refused"; stored: StoredPlan; reasons: string[] };

function refusal(scope: PlanScope, stored: StoredPlan, reasons: string[]): Promise<PlanDraftOutcome> {
  return recordPlanOutcome(scope.sql, { id: stored.id, organizationId: scope.organizationId, plan: null, reasons, catalogReadAt: scope.catalogReadAt }).then(
    (updated) => ({ status: "refused", stored: updated ?? stored, reasons }),
  );
}

export async function planStoredDraft(scope: PlanScope, planId: string): Promise<PlanDraftOutcome> {
  const stored = await getPlan(scope.sql, scope.organizationId, planId);
  if (stored === null) return { status: "not_found" };
  if (stored.status !== "draft" && stored.status !== "refused") {
    return { status: "not_planned", reasons: [`the plan is ${stored.status}; only a draft or a refused plan is planned again`], stored };
  }

  await setPlanStatus(scope.sql, scope.organizationId, planId, "planning");
  const brief = orchestratorBriefSchema.safeParse(stored.brief);
  if (!brief.success) return refusal(scope, stored, ["the brief does not match the brief contract, so no call is made"]);

  const entry = scope.catalog.get(stored.orchestratorModel);
  if (!entry) return refusal(scope, stored, [`orchestrator ${stored.orchestratorModel} is not in the live catalog, so no call is made`]);
  if (entry.kind !== "text") return refusal(scope, stored, [`orchestrator ${stored.orchestratorModel} is a ${entry.kind} model, not a text model, so no call is made`]);
  const { promptUsdPerToken, completionUsdPerToken } = entry.pricing;
  if (promptUsdPerToken === null || completionUsdPerToken === null) {
    return refusal(scope, stored, [`orchestrator ${stored.orchestratorModel} has no per-token price in the listing, so its call cannot be priced and no call is made`]);
  }

  // The client allows one retry of an answer that fails its contract, and the retry is a second paid call. The hold covers both.
  const callUsd = estimateFromPriceUsd({ promptUsdPerToken, completionUsdPerToken }, ORCHESTRATOR_PLAN_ESTIMATE_TOKENS);
  const redoUsd = callUsd;
  const estimateUsd = callUsd;
  const heldUsd = callUsd + redoUsd;
  if (heldUsd > stored.budgetUsd) {
    return refusal(scope, stored, [`the plan call and its one retry are estimated at $${heldUsd.toFixed(4)}, over the plan's $${stored.budgetUsd.toFixed(4)} budget, so no call is made`]);
  }

  const requestId = scope.mint?.request() ?? newId("req_");
  const reservationId = scope.mint?.reservation() ?? newId("res_");
  const createdAt = scope.now();
  // The engine's reservations belong to a request row (migration 0077). A plan call is a request of its own, with the format orchestrator_plan.
  await scope.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, current_stage, state, pause_reason)
    values (${requestId}, ${scope.organizationId}, 'orchestrator_plan', 'normal', 'running', 'plan', ${JSON.stringify({ kind: "orchestrator_plan", planId })}, '')
  `;
  const ledger = scopedLedgerStore(scope.sql, scope.organizationId, reservationId);
  await ledger.createReservation(
    budgetReservationSchema.parse({
      schema: BUDGET_RESERVATION_SCHEMA,
      reservationId,
      requestId,
      workspaceId: scope.organizationId,
      mode: "cap",
      lines: [{ stage: "claude_roles", estimateUsd }],
      estimateUsd,
      redoAllowanceUsd: redoUsd,
      reservedUsd: heldUsd,
      state: "reserved",
      createdAt,
    }),
  );

  const deps: RoleDeps = {
    gateway: scope.gateway,
    ledger,
    now: scope.now,
    journal: sqlRoleCallJournal(scope.sql, { organizationId: scope.organizationId, requestId }),
  };
  const brand: PlannerBrief = { ...brief.data };
  const outcome = await planWithRole({
    deps,
    requestId,
    workspaceId: scope.organizationId,
    reservationId,
    orchestrator: { provider: "openrouter", id: stored.orchestratorModel },
    brief: brand,
    catalog: scope.catalog,
  });

  await scope.sql`
    update engine_requests set status = ${outcome.ok ? "delivered" : "rejected"}, current_stage = 'plan', updated_at = now()
    where organization_id = ${scope.organizationId} and id = ${requestId}
  `;
  if (!outcome.ok) return refusal(scope, stored, outcome.reasons);
  const ready = await recordPlanOutcome(scope.sql, {
    id: planId,
    organizationId: scope.organizationId,
    plan: outcome.plan,
    reasons: [],
    catalogReadAt: scope.catalogReadAt,
  });
  return { status: "ready", stored: ready ?? stored, plan: outcome.plan };
}
