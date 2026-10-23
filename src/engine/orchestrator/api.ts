// The orchestrator's production entry points, for the web layer's server functions. Each one takes the organization it acts for, reads
// the live catalog through the production gateway, and calls the engine's planner, runner or editor. The runtime is loaded on demand, so
// importing this module does not load the job runtime. Without a connected key the catalog is not_connected, and nothing is called.
//
// The switched-off model families of a plan (D16) are the workspace's, with the brand's added when the plan records a brand. The planner,
// the runner and the editor all check against the same set, and the catalog they are shown holds none of its families.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { structuredChat } from "../gateway/openrouter.ts";
import { scopedLedgerStore } from "../jobs/asset-stores-sql.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { NodeChange } from "./stale.ts";
import { editStoredPlan, runStoredPlan, type EditOutcome, type RunOutcome } from "./run.ts";
import { effectiveDisabledFamilies, readBrandPolicy } from "./brand-policy.ts";
import { requireOrchestratorPolicy } from "./policy-store.ts";
import { isDisabledModel } from "../config/model-policy.ts";
import { readOrchestratorCatalog } from "./live-catalog.ts";
import { planStoredDraft, type PlanDraftOutcome } from "./service.ts";
import { productionHandlers, type BrandFacts } from "./production.ts";
import { queueAssetJob } from "./asset-poll.ts";
import type { MeasureOptions } from "./measure.ts";
import { measuredAverageUsdPerSecond } from "./holds.ts";
import { getPlan } from "./store.ts";
import { textChoices, type TextModelChoice } from "./settings.ts";
import { meridianMonthlyBudgetReader, workspaceBudgetFromSettings } from "../jobs/workspace-budget.ts";

/**
 * The gateway the entry points call. Production passes none, and the runtime's gateway is used. A test passes a gateway that answers from
 * recorded replies, so no test calls a provider.
 */
export type ApiDeps = { gateway?: Gateway };

export type CatalogState =
  | { status: "ok"; catalog: Map<string, CatalogEntry>; takenAt: string; disabledFamilies: readonly string[] }
  | { status: "not_connected" | "failed"; reason: string };

/** The ids a run with no reservation carries. Such a run makes no paid call: the executor pauses before one, and the ledger refuses any it made. */
const NO_REQUEST_ID = "req_none";
const NO_RESERVATION_ID = "res_none";

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

/** The gateway, and the asset router for a run, of the production runtime, loaded on demand. A gateway passed in replaces the runtime's gateway. */
async function runtimeFor(sql: Sql, deps: ApiDeps) {
  if (deps.gateway !== undefined) return { gateway: deps.gateway, assetRouter: undefined };
  const { productionComposition } = await import("../jobs/runtime.ts");
  return productionComposition(sql);
}

/**
 * The families a plan is held to (D16): the workspace's switched-off families, with the brand's added when the plan records a brand. A plan
 * with no brand uses the workspace's alone. A plan that is not the organization's has no brand here, so the workspace's alone. A workspace
 * whose stored policy is unreadable throws its reason here, before any catalog read or call: planning, runs and edits refuse with it.
 */
export async function disabledFamiliesFor(sql: Sql, organizationId: string, planId: string): Promise<string[]> {
  const workspace = await requireOrchestratorPolicy(sql, organizationId);
  const plan = await getPlan(sql, organizationId, planId);
  const brandFamilies = plan?.brandId ? await readBrandPolicy(sql, organizationId, plan.brandId) : [];
  return effectiveDisabledFamilies(workspace.disabledModelFamilies, brandFamilies);
}

/** The text models the orchestrator may plan with, read from the live catalog. Without a connected key the read is not_connected. */
export async function textModelsFor(sql: Sql, input: { organizationId: string; now: () => string }, deps: ApiDeps = {}): Promise<TextModelsState> {
  const policy = await requireOrchestratorPolicy(sql, input.organizationId);
  const catalog = await catalogFor(sql, input.organizationId, input.now, policy.disabledModelFamilies, deps);
  if (catalog.status !== "ok") return catalog;
  return { status: "ok", models: textChoices(catalog.catalog) };
}

/** The live catalog with the switched-off families removed. A read that is not connected or fails is returned as it is, and nothing is guessed. */
async function catalogFor(sql: Sql, organizationId: string, now: () => string, disabledFamilies: readonly string[], deps: ApiDeps): Promise<CatalogState> {
  const { gateway } = await runtimeFor(sql, deps);
  const read = await readOrchestratorCatalog(gateway, { organizationId, now });
  if (read.status !== "ok") return { status: read.status, reason: read.reason };
  // A switched-off family (owner direction 2026-10-23; D16) is not in the catalog the orchestrator is shown or checked against.
  const catalog = new Map([...read.catalog.byId].filter(([id]) => !isDisabledModel(id, disabledFamilies)));
  return { status: "ok", catalog, takenAt: read.catalog.takenAt, disabledFamilies };
}

export async function planDraftFor(
  sql: Sql,
  input: { organizationId: string; planId: string; now: () => string },
  deps: ApiDeps = {},
): Promise<PlanDraftOutcome | CatalogState> {
  const disabledFamilies = await disabledFamiliesFor(sql, input.organizationId, input.planId);
  const catalog = await catalogFor(sql, input.organizationId, input.now, disabledFamilies, deps);
  if (catalog.status !== "ok") return catalog;
  const { gateway } = await runtimeFor(sql, deps);
  return planStoredDraft(
    {
      sql,
      organizationId: input.organizationId,
      gateway,
      catalog: catalog.catalog,
      disabledFamilies: catalog.disabledFamilies,
      catalogReadAt: catalog.takenAt,
      now: input.now,
      workspaceBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
    },
    input.planId,
  );
}

/**
 * Runs a stored plan. Measure mode is null unless the caller passes its options: the server function passes them only for an admin who asks,
 * with the workspace's ceiling (D15). The handlers are made from the run's reservation, so every paid call is authorized against it, and the
 * queued-job guard reads the plan's waiting jobs.
 */
export async function runPlanFor(
  sql: Sql,
  input: { organizationId: string; planId: string; now: () => string; measure?: MeasureOptions | null },
  deps: ApiDeps = {},
): Promise<RunOutcome | CatalogState> {
  const disabledFamilies = await disabledFamiliesFor(sql, input.organizationId, input.planId);
  const catalog = await catalogFor(sql, input.organizationId, input.now, disabledFamilies, deps);
  if (catalog.status !== "ok") return catalog;
  const composition = await runtimeFor(sql, deps);
  const gateway = composition.gateway;
  const measure = input.measure ?? null;
  return runStoredPlan(sql, {
    organizationId: input.organizationId,
    planId: input.planId,
    catalog: catalog.catalog,
    disabledFamilies: catalog.disabledFamilies,
    measure,
    budget: {
      workspaceBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
      now: input.now,
      // The handlers are made from the run's reservation, so every paid call is authorized against it. A run that starts at its line has none:
      // its paid steps pause before any call, and the handlers for the steps that spend nothing are made with the ids of no reservation.
      handlersFor: (budget, runMeasure) => {
        const reserved = budget !== null;
        return productionHandlers({
          organizationId: input.organizationId,
          planId: input.planId,
          requestId: budget?.requestId ?? NO_REQUEST_ID,
          reservationId: budget?.reservationId ?? NO_RESERVATION_ID,
          ledger: budget?.ledger ?? scopedLedgerStore(sql, input.organizationId, NO_RESERVATION_ID),
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
          // The run's own asset router: a visual or voice step is made on the run's reservation, like a shot is. None without a reservation.
          // The router refuses and filters by this plan's families: the workspace's, with the brand's added (D16). A plan with no brand has the workspace's.
          router: reserved
            ? composition.assetRouter?.({ organizationId: input.organizationId, requestId: budget.requestId, reservationId: budget.reservationId, disabledFamilies })
            : undefined,
          // A video or avatar the provider accepts is queued here, and the asset poll (engine.asset_poll) settles it.
          queueAsset: reserved ? (entry) => queueAssetJob(sql, input.organizationId, entry) : undefined,
          sql,
          measure: runMeasure,
          catalogReadAt: catalog.takenAt,
        });
      },
    },
  });
}

export async function editPlanStepFor(
  sql: Sql,
  input: { organizationId: string; planId: string; nodeId: string; change: NodeChange; now: () => string },
  deps: ApiDeps = {},
): Promise<EditOutcome | CatalogState> {
  const disabledFamilies = await disabledFamiliesFor(sql, input.organizationId, input.planId);
  const catalog = await catalogFor(sql, input.organizationId, input.now, disabledFamilies, deps);
  if (catalog.status !== "ok") return catalog;
  return editStoredPlan(sql, { organizationId: input.organizationId, planId: input.planId, catalog: catalog.catalog, disabledFamilies: catalog.disabledFamilies, nodeId: input.nodeId, change: input.change });
}

/**
 * The organization's measured average cost per second (D15): the reported bills of its measured clips over their lengths. It is shown, and it
 * never sets a hold. Null until a clip has been measured. Only the organization's clips count.
 */
export async function measuredAverageFor(sql: Sql, organizationId: string): Promise<{ measuredAverageUsdPerSecond: number | null; clips: number; seconds: number }> {
  const average = await measuredAverageUsdPerSecond(sql, organizationId);
  return {
    measuredAverageUsdPerSecond: average === null ? null : average.usdPerSecond,
    clips: average?.clips ?? 0,
    seconds: average?.seconds ?? 0,
  };
}
