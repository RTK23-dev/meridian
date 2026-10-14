// The `estimate_reserve` stage handler (Bible 6.5, 14.1 steps 1 and 2). It prices the scene plan, reserves the estimate against
// the request budget and the workspace month in cap mode (budget/reserve.ts), and runs the `budget` gate (review/gates/budget.ts).
// A reservation that cap mode pauses fails the gate, and no reservation id is returned. An unknown price fails the gate too,
// and nothing is stored.
//
// Two parts. reserveForPlan is pure apart from the LedgerStore it is given: the plan, the budgets and the time go in, and the
// reservation and the gate come out. createEstimateReserveHandler is the stage: it reads the scene_plan artifact (its only
// input, Bible 5.1), reserves under the workspace lock (withWorkspaceLedger), and writes the budget_reservation artifact.
//
// The request budget is ProductionRequest.constraints.budgetUsd, read from the production_request artifact (the registry passes
// it, next to the plan). The workspace's monthly budget has no owner-decided source yet, so it comes from a WorkspaceBudgetSource.
// The default source is not connected, and then the stage refuses to reserve with that reason (Bible 14.4, 20.2).

import { createHash } from "node:crypto";
import { budgets } from "../../config/budgets.ts";
import {
  EngineError,
  encodeUlid,
  productionRequestSchema,
  scenePlanSchema,
  type ArtifactType,
  type BudgetReservation,
  type GateResult,
} from "../../contracts/index.ts";
import { reserve } from "../../budget/reserve.ts";
import type { LedgerStore } from "../../budget/store.ts";
import { checkBudget } from "../../review/gates/budget.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import { withWorkspaceLedger } from "../sql-ledger-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/**
 * The reservation id of one plan of one request. It is derived from the request and the plan artifact, so a repeated job
 * gets the same id and reserve() returns the reservation it already made (Bible 14.1: a paid call is never billed twice).
 * The bytes are a sha256 digest; 48 bits give the time part and 80 bits the random part of a ULID.
 */
export function planReservationId(requestId: string, planArtifactId: string): string {
  const digest = createHash("sha256").update(`estimate_reserve|${requestId}|${planArtifactId}`).digest();
  const time = digest.readUIntBE(0, 6);
  const random = BigInt(`0x${digest.subarray(6, 16).toString("hex")}`);
  return `res_${encodeUlid(time, random)}`;
}

export type ReserveForPlanInput = {
  requestId: string;
  workspaceId: string;
  /** The artifact id of the scene plan. It feeds the reservation id. */
  planArtifactId: string;
  /** The ScenePlan as stored. Parsed here. */
  plan: unknown;
  /** ProductionRequest.constraints.budgetUsd. */
  requestBudgetUsd: number;
  /** The workspace's monthly budget for the month of `now`. */
  workspaceMonthBudgetUsd: number;
  /** ISO time of the reservation. */
  now: string;
};

export type ReserveForPlanResult = {
  /** The budget gate: passes only when the reservation is held and not paused. */
  gate: GateResult;
  /** The stored reservation (reserved or paused), or null when an unknown price stopped it before anything was stored. */
  reservation: BudgetReservation | null;
  /** False when the reservation already existed and nothing new was stored. */
  created: boolean;
};

/**
 * Reserve a scene plan. Cap mode is budgets.productionMode. A paused reservation is returned with its reasons, and the gate
 * fails. An unknown price is refused with its shot named, and the gate fails with nothing stored. Other errors are rethrown.
 */
export async function reserveForPlan(store: LedgerStore, input: ReserveForPlanInput): Promise<ReserveForPlanResult> {
  const plan = scenePlanSchema.safeParse(input.plan);
  if (!plan.success) {
    throw new EngineError("invalid_input", `the scene plan does not parse: ${plan.error.message}`, { stage: "estimate_reserve" });
  }
  const reservationId = planReservationId(input.requestId, input.planArtifactId);
  try {
    const result = await reserve(store, {
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      mode: budgets.productionMode,
      plan: plan.data,
      requestBudgetUsd: input.requestBudgetUsd,
      workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd,
      now: input.now,
      reservationId,
    });
    return { gate: checkBudget(result.reservation), reservation: result.reservation, created: result.created };
  } catch (error) {
    if (error instanceof EngineError && error.kind === "unknown_price") {
      return {
        gate: gateResult("budget", reservationId, [check("reservation_succeeded", false, { detail: `nothing is reserved: ${error.message}` })]),
        reservation: null,
        created: false,
      };
    }
    throw error;
  }
}

/**
 * The workspace's monthly budget for the month of `now`. Two answers. "known" carries the USD amount. "not_connected" carries the
 * reason, and the stage then reserves nothing and refuses with that reason. A made-up amount is never returned (Bible 14.4).
 */
export type WorkspaceMonthBudget = { status: "known"; usd: number } | { status: "not_connected"; reason: string };

export type WorkspaceBudgetScope = { organizationId: string; requestId: string; now: string };

/** The source of the workspace monthly budget. Where that budget is set is an open owner question (Bible 20.2). */
export interface WorkspaceBudgetSource {
  monthBudget(scope: WorkspaceBudgetScope): Promise<WorkspaceMonthBudget>;
}

/**
 * The default source. Nothing in Meridian sets a workspace monthly budget yet, so this source is not connected. The stage refuses
 * to reserve until the owner decides where the budget is set and a source is wired in.
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
  /** Optional. Absent means the default source, which is not connected, so nothing is reserved. */
  workspaceBudget?: WorkspaceBudgetSource;
};

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError("invalid_input", `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`, { stage: ctx.stage });
}

/** A refusal before anything is reserved: the gate fails with the reason, no reservation id is returned, nothing is stored. */
function refusedBeforeReserving(ctx: StageContext, reason: string): StageRunResult {
  return {
    kind: "done",
    output: {
      stage: "estimate_reserve",
      subjectId: ctx.subjectId,
      artifacts: {},
      gate: gateResult("budget", ctx.requestId, [check("reservation_succeeded", false, { detail: `nothing is reserved: ${reason}` })]),
      budgetReservationId: null,
    },
  };
}

/**
 * The estimate_reserve stage. It reads the scene plan and the production request (for its budget). It refuses to reserve when the
 * workspace monthly budget is not connected, or is not a usable amount: the reason is the gate's detail.
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
      const now = new Date().toISOString();
      const month = await source.monthBudget({ organizationId: ctx.organizationId, requestId: ctx.requestId, now });
      if (month.status !== "known") return refusedBeforeReserving(ctx, month.reason);
      if (!Number.isFinite(month.usd) || month.usd < 0) {
        return refusedBeforeReserving(ctx, `the workspace monthly budget source returned ${String(month.usd)}, which is not a usable amount`);
      }

      const result = await withWorkspaceLedger(ctx.sql, ctx.organizationId, (store) =>
        reserveForPlan(store, {
          requestId: ctx.requestId,
          workspaceId: ctx.organizationId,
          planArtifactId: planArtifact.envelope.artifactId,
          plan: planArtifact.envelope.body,
          requestBudgetUsd: parsedRequest.data.constraints.budgetUsd,
          workspaceMonthBudgetUsd: month.usd,
          now,
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
      const reservationId = result.gate.pass && result.reservation !== null ? result.reservation.reservationId : null;
      return {
        kind: "done",
        output: { stage: "estimate_reserve", subjectId: ctx.subjectId, artifacts, gate: result.gate, budgetReservationId: reservationId },
      };
    },
  };
}
