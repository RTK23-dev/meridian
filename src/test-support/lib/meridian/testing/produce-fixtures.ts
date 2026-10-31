/**
 * Fixtures for the Factory produce and stage-flow suites: a run with its settings, the Plan stage's rows for it, the queue job a
 * stage runs under, the approval a person gives, and a stub for the one image provider call. The tenant is the Studio fixture.
 * Everything around the stubbed call is the real lifecycle: the stage, the reservation, the artifact, the materializer and the review.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../../../../lib/meridian/learning/store.ts";
import type { ExecutableJob } from "../../../../lib/meridian/jobs/execute.ts";
import { creativePlanFor, storedPlanOf, type PlanAttributes } from "../../../../lib/meridian/factory/plan.ts";
import type { Concept } from "../../../../lib/meridian/factory/pick.ts";
import { DEFAULT_RUN_SETTINGS, factoryLevelOfAutomation, type AutomationMode, type RunSettings } from "../../../../lib/meridian/factory/run-settings.ts";
import { productionRouter } from "../../../../lib/meridian/production/router.ts";
import type { ImageGenerationInput, ImageGenerationOutcome, ProductionImageProvider } from "../../../../lib/meridian/production/image-providers.ts";
import { PNG, studioTenant } from "./durable-image-fixtures.ts";

export { studioTenant };

export type FactoryTenant = Awaited<ReturnType<typeof studioTenant>>;

/** A run for the tenant, with the given settings laid over the defaults. Its current stage starts at discover, as a new run does. */
export async function factoryRunFor(
  sql: Sql,
  tenant: FactoryTenant,
  settings: Partial<Omit<RunSettings, "caps">> & { automation: AutomationMode; caps?: Partial<RunSettings["caps"]> },
): Promise<string> {
  const runId = randomUUID();
  const effective: RunSettings = { ...DEFAULT_RUN_SETTINGS, ...settings, caps: { ...DEFAULT_RUN_SETTINGS.caps, ...(settings.caps ?? {}) } };
  await sql`
    insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, error, created_by, settings)
    values (${runId}, ${tenant.organizationId}, ${tenant.brandId}, 'kitchen', ${factoryLevelOfAutomation(effective.automation)},
      'queued', 'factory.discover', '', ${tenant.userId}, ${JSON.stringify(effective)})
  `;
  return runId;
}

/**
 * One template and one control variant for each pick, written the way the Plan stage writes them. The CreativePlan is the real one,
 * made by creativePlanFor, so the materializer reads the same lineage and product name a real run would.
 */
export async function planRowsFor(sql: Sql, tenant: FactoryTenant, runId: string, formats: string[], picks = 1): Promise<string[]> {
  const variantIds: string[] = [];
  for (let pick = 0; pick < picks; pick += 1) {
    const templateId = `tpl:${runId}:ad-${pick}-${randomUUID()}`;
    const concept: Concept = {
      key: `demo|question|live demonstration-${pick}`,
      label: `demo / question hook / live demonstration ${pick + 1}`,
      angle: "live demonstration",
      hookType: "question",
      format: "demo",
    };
    const attributes: PlanAttributes = {
      hook: "question",
      angle: "live demonstration",
      format: "demo",
      proof: "",
      cta: "",
      presenter: "",
      lengthMs: 8000,
    };
    const creativePlan = creativePlanFor({
      templateId,
      concept,
      attributes,
      decisionId: `gate-${randomUUID()}`,
      researchAdId: `ad-${pick}`,
      winnerScore: 0.5,
      productName: "Mesh sponge",
      audience: "",
      run: { formats, automation: "full", intent: "organic", capTotalCents: 0 },
      now: new Date().toISOString(),
    });
    await sql`
      insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard, plan)
      values (${templateId}, ${tenant.organizationId}, ${tenant.brandId}, ${`ad-${pick}`}, '{}', ${storedPlanOf(attributes, creativePlan)})
    `;
    const variantId = `var:${templateId}:0`.slice(0, 180);
    await sql`
      insert into factory_variants (
        id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result, tests_attribute, angle, format, proof
      ) values (
        ${variantId}, ${tenant.organizationId}, ${tenant.brandId}, ${templateId}, ${attributes.hook}, '', '', 8000, 'review',
        'control', ${attributes.angle}, ${attributes.format}, ''
      )
    `;
    variantIds.push(variantId);
  }
  return variantIds;
}

/** The queue job a stage runs under, shaped as the job runner passes it to executeFactoryJob. */
export function stageJob(tenant: FactoryTenant, runId: string, jobType: string): ExecutableJob {
  return {
    id: randomUUID(),
    organization_id: tenant.organizationId,
    brand_id: tenant.brandId,
    job_type: jobType,
    payload: JSON.stringify({ runId }),
    attempts: 0,
    max_attempts: 3,
  };
}

/** A person's approval of one waiting stage, recorded the way approveFactoryStage records it, and the run released from its wait. */
export async function approveStage(sql: Sql, tenant: FactoryTenant, runId: string, stage: string): Promise<void> {
  await sql`
    insert into factory_approvals (id, organization_id, brand_id, run_id, stage, approved_by)
    values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, ${runId}, ${stage}, ${tenant.userId})
  `;
  await sql`
    update factory_runs set status = 'queued', error = '', updated_at = now()
    where id = ${runId} and organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and status = 'awaiting_approval'
  `;
}

export async function runRow(sql: Sql, tenant: FactoryTenant, runId: string) {
  const [row] = await sql<{ status: string; current_stage: string; error: string }>`
    select status, current_stage, error from factory_runs
    where id = ${runId} and organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
  `;
  return row!;
}

export type ImageStubOptions = {
  /** False makes the provider report NOT_CONFIGURED from its health check, so a named choice is refused before any reservation. */
  configured?: boolean;
  /** What a call that returns does: an image, a failure, or NOT_CONNECTED. */
  outcome?: "ready" | "failed" | "not-connected";
  /** Makes the call throw instead of return, so its outcome is unknown. */
  throws?: boolean;
  /** The cost the stub reports for a ready image, in cents. Absent reports none. */
  costCents?: number | null;
};

/**
 * Replaces the Google image provider for one test, and records each call. A test restores the provider it replaced. The stub stands in
 * for the external call only; its health check, its reservation and everything after the call are the real ones.
 *
 * The answer is shaped after the image-generation documentation the model registry cites for these models
 * (https://ai.google.dev/gemini-api/docs/image-generation). It is a fixture, not a recorded response, and it has not been checked
 * against a live call. It reports no cost unless a test asks for one, because the adapter reports none. A reported cost here is a
 * fixture value that exercises the metered path, not a price.
 */
export function stubImageProvider(options: ImageStubOptions = {}) {
  const state = { calls: 0, inputs: [] as ImageGenerationInput[] };
  const provider: ProductionImageProvider = {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false },
    async health() {
      const configured = options.configured !== false;
      return {
        id: "google_nano_banana",
        state: configured ? "CONFIGURED" : "NOT_CONFIGURED",
        capabilities: ["text-to-image"],
        detail: configured ? "Fixture image provider is configured." : "Fixture image provider has no credential.",
        checkedAt: new Date().toISOString(),
      };
    },
    async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
      state.calls += 1;
      state.inputs.push(input);
      if (options.throws) throw new Error("scripted: the provider call did not return");
      if (options.outcome === "failed") return { status: "failed", provider: "google:nano-banana", error: "scripted provider failure" };
      if (options.outcome === "not-connected") {
        return { status: "NOT_CONNECTED", provider: "google:nano-banana", error: "Google image credentials are not configured (fixture)." };
      }
      return {
        status: "ready",
        provider: "google:nano-banana",
        model: input.model,
        promptVersion: input.promptVersion,
        mediaType: "image/png",
        bytes: PNG,
        width: 1,
        height: 1,
        costCents: options.costCents ?? null,
      };
    },
  };
  const original = productionRouter.getImage("google_nano_banana");
  productionRouter.registerImage(provider);
  return {
    state,
    restore() {
      if (original) productionRouter.registerImage(original);
    },
  };
}
