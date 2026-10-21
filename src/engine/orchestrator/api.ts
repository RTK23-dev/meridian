// The orchestrator's production entry points, for the web layer's server functions. Each one takes the organization it acts for, reads
// the live catalog through the production gateway, and calls the engine's planner, runner or editor. The runtime is loaded on demand, so
// importing this module does not load the job runtime. Without a connected key the catalog is not_connected, and nothing is called.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeChange } from "./stale.ts";
import { editStoredPlan, runStoredPlan, type EditOutcome, type RunOutcome } from "./run.ts";
import { readOrchestratorCatalog } from "./live-catalog.ts";
import { planStoredDraft, type PlanDraftOutcome } from "./service.ts";
import type { Handlers } from "./execute.ts";
import { textChoices, type TextModelChoice } from "./settings.ts";

export type CatalogState =
  | { status: "ok"; catalog: Map<string, CatalogEntry>; takenAt: string }
  | { status: "not_connected" | "failed"; reason: string };

/** Production handlers for the plan's step kinds. None is connected yet: a step with no handler reports not_connected. */
export const PRODUCTION_STEP_HANDLERS: Handlers = {};

export type TextModelsState = { status: "ok"; models: TextModelChoice[] } | { status: "not_connected" | "failed"; reason: string };

/** The text models the orchestrator may plan with, read from the live catalog. Without a connected key the read is not_connected. */
export async function textModelsFor(sql: Sql, input: { organizationId: string; now: () => string }): Promise<TextModelsState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  return { status: "ok", models: textChoices(catalog.catalog) };
}

async function catalogFor(sql: Sql, organizationId: string, now: () => string): Promise<CatalogState> {
  const { productionComposition } = await import("../jobs/runtime.ts");
  const read = await readOrchestratorCatalog(productionComposition(sql).gateway, { organizationId, now });
  if (read.status !== "ok") return { status: read.status, reason: read.reason };
  return { status: "ok", catalog: read.catalog.byId, takenAt: read.catalog.takenAt };
}

export async function planDraftFor(sql: Sql, input: { organizationId: string; planId: string; now: () => string }): Promise<PlanDraftOutcome | CatalogState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  const { productionComposition } = await import("../jobs/runtime.ts");
  return planStoredDraft(
    { sql, organizationId: input.organizationId, gateway: productionComposition(sql).gateway, catalog: catalog.catalog, catalogReadAt: catalog.takenAt, now: input.now },
    input.planId,
  );
}

export async function runPlanFor(sql: Sql, input: { organizationId: string; planId: string; now: () => string }): Promise<RunOutcome | CatalogState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  return runStoredPlan(sql, { organizationId: input.organizationId, planId: input.planId, catalog: catalog.catalog, handlers: PRODUCTION_STEP_HANDLERS });
}

export async function editPlanStepFor(
  sql: Sql,
  input: { organizationId: string; planId: string; nodeId: string; change: NodeChange; now: () => string },
): Promise<EditOutcome | CatalogState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  return editStoredPlan(sql, { organizationId: input.organizationId, planId: input.planId, catalog: catalog.catalog, nodeId: input.nodeId, change: input.change });
}
