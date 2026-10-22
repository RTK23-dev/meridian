// The orchestrator's production entry points, for the web layer's server functions. Each one takes the organization it acts for, reads
// the live catalog through the production gateway, and calls the engine's planner, runner or editor. The runtime is loaded on demand, so
// importing this module does not load the job runtime. Without a connected key the catalog is not_connected, and nothing is called.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { structuredChat } from "../gateway/openrouter.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeChange } from "./stale.ts";
import { editStoredPlan, runStoredPlan, type EditOutcome, type RunOutcome } from "./run.ts";
import { readOrchestratorCatalog } from "./live-catalog.ts";
import { planStoredDraft, type PlanDraftOutcome } from "./service.ts";
import { productionHandlers, type BrandFacts } from "./production.ts";
import { textChoices, type TextModelChoice } from "./settings.ts";
import { meridianMonthlyBudgetReader, workspaceBudgetFromSettings } from "../jobs/workspace-budget.ts";

export type CatalogState =
  | { status: "ok"; catalog: Map<string, CatalogEntry>; takenAt: string }
  | { status: "not_connected" | "failed"; reason: string };

/** The brand's facts from the organization's record, or null when it is not the organization's or is deleted. */
async function readBrandFacts(sql: Sql, organizationId: string, brandId: string): Promise<BrandFacts | null> {
  const rows = (await sql`
    select name, description, category, industry, website, country_market, sells from brands
    where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    name: String(row.name),
    description: String(row.description),
    category: String(row.category),
    industry: String(row.industry),
    website: String(row.website),
    countryMarket: String(row.country_market),
    sells: String(row.sells),
  };
}

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
    {
      sql,
      organizationId: input.organizationId,
      gateway: productionComposition(sql).gateway,
      catalog: catalog.catalog,
      catalogReadAt: catalog.takenAt,
      now: input.now,
      workspaceBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
    },
    input.planId,
  );
}

export async function runPlanFor(sql: Sql, input: { organizationId: string; planId: string; now: () => string }): Promise<RunOutcome | CatalogState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  const { productionComposition } = await import("../jobs/runtime.ts");
  const gateway = productionComposition(sql).gateway;
  return runStoredPlan(sql, {
    organizationId: input.organizationId,
    planId: input.planId,
    catalog: catalog.catalog,
    budget: {
      workspaceBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
      now: input.now,
      // The handlers are made from the run's reservation, so every paid call is authorized against it.
      handlersFor: (budget) =>
        productionHandlers({
          organizationId: input.organizationId,
          planId: input.planId,
          reservationId: budget.reservationId,
          ledger: budget.ledger,
          now: input.now,
          connection: () => gateway.connection("openrouter", input.organizationId),
          textRoute: (modelId) => gateway.chosen("llm.analysis", modelId),
          structured: async (route, call) => {
            const result = await structuredChat(gateway, {
              organizationId: input.organizationId,
              capability: "llm.analysis",
              route,
              messages: call.messages,
              schema: call.schema,
              schemaName: call.schemaName,
              maxTokens: call.maxTokens,
              stage: call.stage,
            });
            return { value: result.value, actualUsd: result.usage.costUsd };
          },
          brand: (brandId) => readBrandFacts(sql, input.organizationId, brandId),
        }),
    },
  });
}

export async function editPlanStepFor(
  sql: Sql,
  input: { organizationId: string; planId: string; nodeId: string; change: NodeChange; now: () => string },
): Promise<EditOutcome | CatalogState> {
  const catalog = await catalogFor(sql, input.organizationId, input.now);
  if (catalog.status !== "ok") return catalog;
  return editStoredPlan(sql, { organizationId: input.organizationId, planId: input.planId, catalog: catalog.catalog, nodeId: input.nodeId, change: input.change });
}
