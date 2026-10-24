// The production render port of a repurposed cut. It runs the engine's own compose and render stage handlers (jobs/handlers/compose.ts and
// render.ts) on the child cut, under a hold of its own (budget/render-reserve.ts). It is not a second renderer: the handlers check the price,
// the composition hash and the integrity gate, and write the composition, the gate result and the rendered video with their lineage.
// The Shotstack fallback is not passed, so a cut HyperFrames cannot render is refused rather than sent to a second provider.
//
// A stage that does not finish is an error, so the variation stays in `rendering` and is not sent again: the renderer may already have
// billed the call.

import { reserveRenderLine } from "../../../engine/budget/render-reserve.ts";
import { createComposeHandler, type ComposePorts } from "../../../engine/jobs/handlers/compose.ts";
import { createRenderHandler, type RenderPorts } from "../../../engine/jobs/handlers/render.ts";
import { sqlLedgerStore } from "../../../engine/jobs/sql-ledger-store.ts";
import { stableId } from "../../../engine/jobs/stable-id.ts";
import type { EnginePayload, StageContext } from "../../../engine/jobs/types.ts";
import type { GateResult } from "../../../engine/contracts/gate.ts";
import type { Sql } from "../learning/store.ts";
import type { RepurposeRenderPort } from "./repurpose.ts";

export type RepurposeBudget = { requestBudgetUsd: number; workspaceMonthBudgetUsd: number };

export type EngineRepurposeRenderInput = {
  sql: Sql;
  composePorts: ComposePorts;
  renderPorts: RenderPorts;
  /** The request budget and the workspace month budget the cut's hold is checked against. Null when either is not set: the cut is refused. */
  budgetOf: (scope: { organizationId: string; requestId: string; now: string }) => Promise<RepurposeBudget | null>;
  now: () => string;
};

type JobBase = {
  sql: Sql;
  jobId: string;
  organizationId: string;
  requestId: string;
  attempt: string;
  signal: AbortSignal;
};

export type RepurposeRenderOutcome = { status: "rendered"; artifactId: string } | { status: "failed"; reason: string };

/** The engine request's stored state, read as the repurpose service reads the master. Only the artifact map is used here. */
async function artifactsOfRequest(sql: Sql, organizationId: string, requestId: string): Promise<Record<string, string>> {
  const rows = await sql<{ state: string }>`select state from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1`;
  if (rows.length === 0) throw new Error("The engine request of this video was not found.");
  const state = JSON.parse(rows[0]!.state) as { artifacts?: Record<string, string> };
  return state.artifacts ?? {};
}

/** The stage context a handler receives for one job of a child cut. The payload is what the orchestrator would have queued. */
function stageContext(base: JobBase, job: { stage: StageContext["stage"]; subjectId: string; inputArtifactIds: string[]; budgetReservationId: string | null }): StageContext {
  const payload: EnginePayload = {
    organizationId: base.organizationId,
    requestId: base.requestId,
    stage: job.stage,
    subjectId: job.subjectId,
    attempt: base.attempt,
    priority: "normal",
    budgetReservationId: job.budgetReservationId,
    inputArtifactIds: job.inputArtifactIds,
    hints: [],
    details: {},
  };
  return { ...base, stage: job.stage, subjectId: job.subjectId, payload };
}

/** Why the integrity gate refused a cut, from the checks that failed. Never empty: a refusal always says something. */
export function refusalOf(gate: GateResult): string {
  const failed = gate.checks.filter((check) => !check.pass).map((check) => check.detail ?? check.rule);
  return failed.length > 0 ? failed.join("; ") : "the integrity gate did not pass";
}

export function engineRepurposeRenderPort(input: EngineRepurposeRenderInput): RepurposeRenderPort {
  return async (child): Promise<RepurposeRenderOutcome> => {
    const now = input.now();
    const artifacts = await artifactsOfRequest(input.sql, child.organizationId, child.engineRequestId);
    const validatedArtifactId = artifacts.validated;
    if (validatedArtifactId === undefined) {
      return { status: "failed", reason: "The engine request has no validated plan, so this cut cannot be rendered." };
    }

    const base: JobBase = {
      sql: input.sql,
      jobId: `repurpose:${child.engineRequestId}:${child.variationKey}`,
      organizationId: child.organizationId,
      requestId: child.engineRequestId,
      attempt: "1",
      signal: new AbortController().signal,
    };
    const edlId = child.edl.edlId;

    // The compose stage writes the composition the render stage checks against the EDL and the style kit.
    const composed = await createComposeHandler(input.composePorts).run(
      stageContext(base, { stage: "compose", subjectId: edlId, inputArtifactIds: [child.childArtifactId, validatedArtifactId], budgetReservationId: null }),
    );
    if (composed.kind !== "done") throw new Error("The compose stage did not finish, so the cut was not rendered.");
    const compositionArtifactId = composed.output.artifacts[`composition:${edlId}`];
    if (compositionArtifactId === undefined) throw new Error("The compose stage returned no composition for this cut.");

    // The cut's own hold. Refused when it would exceed the request budget or the workspace month, and then nothing is sent.
    const budget = await input.budgetOf({ organizationId: child.organizationId, requestId: child.engineRequestId, now });
    if (budget === null) return { status: "failed", reason: "The request has no budget set, so this cut is not funded and is not rendered." };
    const reservationId = stableId("res_", `repurpose|${child.engineRequestId}|${child.variationKey}`);
    const { reservation } = await reserveRenderLine(sqlLedgerStore(input.sql, child.organizationId), {
      reservationId,
      requestId: child.engineRequestId,
      workspaceId: child.organizationId,
      stage: "render",
      estimateUsd: child.estimateUsd,
      requestBudgetUsd: budget.requestBudgetUsd,
      workspaceMonthBudgetUsd: budget.workspaceMonthBudgetUsd,
      now,
    });
    if (reservation.state !== "reserved") {
      return { status: "failed", reason: `The budget does not allow this render: ${reservation.pausedReason ?? "a limit would be exceeded"}.` };
    }

    // The render stage checks the price, the composition hash and the integrity gate, and writes the rendered video on a pass.
    const rendered = await createRenderHandler(input.renderPorts).run(
      stageContext(base, {
        stage: "render",
        subjectId: edlId,
        inputArtifactIds: [compositionArtifactId, child.childArtifactId, validatedArtifactId],
        budgetReservationId: reservationId,
      }),
    );
    if (rendered.kind !== "done" || rendered.output.stage !== "render") {
      throw new Error("The renderer accepted this cut but has not returned it, so it stays in rendering until it is settled.");
    }
    const videoArtifactId = rendered.output.artifacts[`render:${edlId}`];
    if (rendered.output.gate.pass && videoArtifactId !== undefined) return { status: "rendered", artifactId: videoArtifactId };
    return { status: "failed", reason: refusalOf(rendered.output.gate) };
  };
}
