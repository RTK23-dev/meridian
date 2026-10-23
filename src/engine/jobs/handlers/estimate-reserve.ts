// The `estimate_reserve` stage handler (Bible 6.5, 14.1 steps 1 and 2). It prices the scene plan and raises the request's pre-flight
// hold to the plan's estimate (budget/preflight.ts extendReservation), then runs the `budget` gate (review/gates/budget.ts).
// The hold is the one intake made (E3 lead decision 1): this stage never makes a second reservation. A raise that cap mode
// pauses, a refusal, and an unknown price all fail the gate; no reservation id is returned, and the orchestrator pauses on budget.
//
// Two parts. extendForPlan is pure apart from the LedgerStore it is given: the plan, the budgets and the time go in, and the
// reservation and the gate come out. createEstimateReserveHandler is the stage: it reads the scene_plan and production_request
// artifacts (its inputs, Bible 5.1), extends under the workspace lock (withWorkspaceLedger), and writes the budget_reservation
// artifact.
//
// The request budget is ProductionRequest.constraints.budgetUsd, read from the production_request artifact. The workspace's
// monthly budget comes from a WorkspaceBudgetSource (workspace-budget.ts reads it from Meridian's Settings, owner decision
// 2026-10-14). The default source is not connected, and then the stage refuses to extend with that reason (Bible 14.4, 20.2).

import {
  EngineError,
  productionRequestSchema,
  scenePlanSchema,
  type ArtifactType,
  type BudgetReservation,
  type GateResult,
  type ScenePlan,
} from "../../contracts/index.ts";
import { extendReservation } from "../../budget/preflight.ts";
import type { ChosenCallPrices } from "../../budget/estimate.ts";
import type { BudgetTolerance } from "../../budget/tolerance.ts";
import { modelChoicesSchema } from "../../contracts/model-choices.ts";
import type { CatalogRead, ModelCatalogSource } from "../../gateway/catalog.ts";
import { chosenCallPricesOf } from "../../plan/model-choices.ts";
import type { LedgerStore } from "../../budget/store.ts";
import { checkBudget } from "../../review/gates/budget.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import { withWorkspaceLedger } from "../sql-ledger-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

export type ExtendForPlanInput = {
  requestId: string;
  workspaceId: string;
  /** The pre-flight hold's reservation id, from intake. */
  reservationId: string;
  /** The ScenePlan as stored. Parsed here. */
  plan: unknown;
  /** ProductionRequest.constraints.budgetUsd. */
  requestBudgetUsd: number;
  /** The workspace's monthly budget for the month of `now`. */
  workspaceMonthBudgetUsd: number;
  /** ISO time of the extension. */
  now: string;
  /** The catalog prices of the calls whose model the orchestrator chose (Bible 10.5). Absent: the price table prices every call. */
  chosenPrices?: ChosenCallPrices;
  /** The overrun tolerance on both budgets (owner direction 2026-10-23), from the workspace month budget source. */
  tolerance?: BudgetTolerance;
};

export type ExtendForPlanResult = {
  /** The budget gate: passes only when the extended hold is held and covers the plan's estimate. */
  gate: GateResult;
  /** The reservation after the extension, or null when it was paused, refused or unpriced (nothing new is held). */
  reservation: BudgetReservation | null;
};

/**
 * Raise the pre-flight hold to the plan's estimate. A paused or refused extension fails the gate with its reasons, and the hold
 * keeps what it had. An unknown price is refused with its shot named (the extension throws before it writes anything).
 */
export async function extendForPlan(store: LedgerStore, input: ExtendForPlanInput): Promise<ExtendForPlanResult> {
  const plan = scenePlanSchema.safeParse(input.plan);
  if (!plan.success) {
    throw new EngineError("invalid_input", `the scene plan does not parse: ${plan.error.message}`, { stage: "estimate_reserve" });
  }
  let outcome;
  try {
    outcome = await extendReservation(store, {
      reservationId: input.reservationId,
      plan: plan.data as ScenePlan,
      requestBudgetUsd: input.requestBudgetUsd,
      workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd,
      now: input.now,
      ...(input.tolerance === undefined ? {} : { tolerance: input.tolerance }),
      ...(input.chosenPrices === undefined ? {} : { chosenPrices: input.chosenPrices }),
    });
  } catch (error) {
    if (error instanceof EngineError && error.kind === "unknown_price") {
      return {
        gate: gateResult("budget", input.reservationId, [check("reservation_succeeded", false, { detail: `nothing is extended: ${error.message}` })]),
        reservation: null,
      };
    }
    throw error;
  }
  if (outcome.status === "extended") {
    return { gate: checkBudget(outcome.reservation), reservation: outcome.reservation };
  }
  const chosen = input.chosenPrices?.size ?? 0;
  const priced = chosen === 0 ? "" : ` (${chosen} call${chosen === 1 ? "" : "s"} priced at the chosen model's catalog price, Bible 10.5)`;
  const reason = `${outcome.status === "paused" ? outcome.reasons.join("; ") : outcome.reason}${priced}`;
  return {
    gate: gateResult("budget", input.reservationId, [check("reservation_succeeded", false, { detail: `the hold is not raised: ${reason}` })]),
    reservation: null,
  };
}

/** The workspace's monthly budget for the month of `now`. Two answers. "known" carries the USD amount; "not_connected" the reason. */
/** The workspace month budget. `tolerance` is the overrun tolerance a production source reads from the workspace policy (owner direction 2026-10-23). */
export type WorkspaceMonthBudget = { status: "known"; usd: number; tolerance?: BudgetTolerance } | { status: "not_connected"; reason: string };

export type WorkspaceBudgetScope = { organizationId: string; requestId: string; now: string };

/** The source of the workspace monthly budget (Bible 14.1 step 2). Production reads Meridian's Settings (workspace-budget.ts). */
export interface WorkspaceBudgetSource {
  monthBudget(scope: WorkspaceBudgetScope): Promise<WorkspaceMonthBudget>;
}

/**
 * The default source. Nothing sets the workspace monthly budget in this composition, so this source is not connected. The stage
 * refuses to extend the hold until a source is wired in.
 */
export const notConnectedWorkspaceBudget: WorkspaceBudgetSource = {
  async monthBudget() {
    return {
      status: "not_connected",
      reason: "the workspace monthly budget is not connected: no source sets it yet (an open owner decision, Bible 20.2)",
    };
  },
};

export type EstimateReservePorts = {
  /** Optional. Absent means the default source, which is not connected, so nothing is extended. */
  workspaceBudget?: WorkspaceBudgetSource;
  /**
   * OpenRouter's model catalog (gateway/catalog.ts), the same cache the routers read. With a model_choices input, each chosen call is
   * priced at its chosen model's catalog estimate (the router's per-submit estimate), so the reservation covers what will be called.
   * Absent, or a choice the catalog no longer supports: that call is priced from the price table, as the router then routes it.
   */
  catalog?: ModelCatalogSource;
};

/** The optional input artifact of a type, or null when the job names none. */
async function readOptionalInput(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact | null> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  return null;
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError("invalid_input", `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`, { stage: ctx.stage });
}

/** A refusal before anything is extended: the gate fails with the reason, no reservation id is returned, nothing is stored. */
function refusedBeforeExtending(ctx: StageContext, reason: string): StageRunResult {
  return {
    kind: "done",
    output: {
      stage: "estimate_reserve",
      subjectId: ctx.subjectId,
      artifacts: {},
      gate: gateResult("budget", ctx.requestId, [check("reservation_succeeded", false, { detail: `nothing is extended: ${reason}` })]),
      budgetReservationId: null,
    },
  };
}

/**
 * The estimate_reserve stage. It reads the scene plan and the production request (for its budget), and extends the reservation
 * intake made. It refuses when there is no hold, when the workspace month is not connected, or when the month is not a usable
 * amount: the reason is the gate's detail.
 */
export function createEstimateReserveHandler(ports: EstimateReservePorts = {}): StageHandler {
  const source = ports.workspaceBudget ?? notConnectedWorkspaceBudget;
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const planArtifact = await readInputOfType(ctx, "scene_plan");
      const requestArtifact = await readInputOfType(ctx, "production_request");
      const parsedRequest = productionRequestSchema.safeParse(requestArtifact.envelope.body);
      if (!parsedRequest.success) {
        throw new EngineError("invalid_input", `the production request artifact does not parse: ${parsedRequest.error.message}`, {
          stage: ctx.stage,
        });
      }
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) {
        return refusedBeforeExtending(ctx, "intake made no pre-flight hold on this request");
      }
      const now = new Date().toISOString();
      const month = await source.monthBudget({ organizationId: ctx.organizationId, requestId: ctx.requestId, now });
      if (month.status !== "known") return refusedBeforeExtending(ctx, month.reason);
      if (!Number.isFinite(month.usd) || month.usd < 0) {
        return refusedBeforeExtending(ctx, `the workspace monthly budget source returned ${String(month.usd)}, which is not a usable amount`);
      }

      // The chosen models' catalog prices (Bible 10.5 step 5). A request with no model_choices input is priced as before.
      let chosenPrices: ChosenCallPrices | undefined;
      const choicesArtifact = await readOptionalInput(ctx, "model_choices");
      if (choicesArtifact !== null) {
        const choices = modelChoicesSchema.safeParse(choicesArtifact.envelope.body);
        const plan = scenePlanSchema.safeParse(planArtifact.envelope.body);
        if (!choices.success || !plan.success) {
          throw new EngineError("invalid_input", "the model choices or the scene plan do not parse", { stage: ctx.stage });
        }
        const catalog: CatalogRead =
          ports.catalog === undefined ? { status: "not_connected", reason: "this runtime has no model catalog" } : await ports.catalog.read(ctx.organizationId);
        chosenPrices = chosenCallPricesOf({ plan: plan.data, choices: choices.data, catalog }).prices;
      }

      const result = await withWorkspaceLedger(ctx.sql, ctx.organizationId, (store) =>
        extendForPlan(store, {
          requestId: ctx.requestId,
          workspaceId: ctx.organizationId,
          reservationId,
          plan: planArtifact.envelope.body,
          requestBudgetUsd: parsedRequest.data.constraints.budgetUsd,
          workspaceMonthBudgetUsd: month.usd,
          now,
          ...(month.tolerance === undefined ? {} : { tolerance: month.tolerance }),
          ...(chosenPrices === undefined ? {} : { chosenPrices }),
        }),
      );

      const artifacts: Record<string, string> = {};
      if (result.reservation !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "budget_reservation",
          body: result.reservation,
          parentIds: [planArtifact.envelope.artifactId],
          createdAt: now,
        });
        artifacts.budget = written.artifactId;
      }
      const passed = result.gate.pass && result.reservation !== null;
      return {
        kind: "done",
        output: {
          stage: "estimate_reserve",
          subjectId: ctx.subjectId,
          artifacts,
          gate: result.gate,
          budgetReservationId: passed ? reservationId : null,
        },
      };
    },
  };
}
