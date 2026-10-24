// The production wiring of the repurpose render port. It takes the engine's production render ports (the same renderer and object store a
// master video uses), its style-kit loader and its workspace month budget. The repurpose service reads the render price first, so while the
// HyperFrames price is unverified no cut reaches this port and every variation is recorded as not priced.

import { readArtifact } from "../../../engine/jobs/artifact-store.ts";
import { kitPorts } from "../../../engine/jobs/kit-store.ts";
import { productionComposition } from "../../../engine/jobs/runtime.ts";
import { validatedRequestSchema } from "../../../engine/contracts/index.ts";
import type { Sql } from "../learning/store.ts";
import type { RepurposeRenderPort } from "./repurpose.ts";
import { engineRepurposeRenderPort } from "./repurpose-render.ts";

/** The request budget of the engine request, from its validated plan. Null when the plan does not set one. */
async function requestBudgetUsdOf(sql: Sql, organizationId: string, requestId: string): Promise<number | null> {
  const rows = await sql<{ state: string }>`select state from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1`;
  const state = JSON.parse(rows[0]?.state ?? "{}") as { artifacts?: Record<string, string> };
  const validatedArtifactId = state.artifacts?.validated;
  if (validatedArtifactId === undefined) return null;
  const stored = await readArtifact(sql, { organizationId, artifactId: validatedArtifactId });
  return validatedRequestSchema.parse(stored.envelope.body).request.constraints.budgetUsd ?? null;
}

/** The production render port, or undefined when the engine has no render ports (the cut is then not rendered, and says why). */
export function productionRepurposeRenderPort(sql: Sql): RepurposeRenderPort | undefined {
  const composition = productionComposition(sql);
  if (composition.render === undefined) return undefined;
  return engineRepurposeRenderPort({
    sql,
    composePorts: { loadStyleKit: kitPorts(sql).loadStyleKit, now: () => new Date().toISOString() },
    renderPorts: composition.render,
    budgetOf: async ({ organizationId, requestId, now }) => {
      const month = await composition.workspaceBudget.monthBudget({ organizationId, requestId, now });
      if (month.status !== "known") return null;
      const requestBudgetUsd = await requestBudgetUsdOf(sql, organizationId, requestId);
      if (requestBudgetUsd === null) return null;
      return { requestBudgetUsd, workspaceMonthBudgetUsd: month.usd };
    },
    now: () => new Date().toISOString(),
  });
}
