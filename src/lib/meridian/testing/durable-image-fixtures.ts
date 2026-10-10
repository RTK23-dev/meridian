/**
 * Shared fixtures for the durable image and carousel suites. These create real tenant, brief, decision, and plan rows and
 * stub only the external image provider call. The lifecycle around the call is the real one.
 */
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { Sql } from "../learning/store.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "./plan-lineage.ts";
import { productionRouter } from "../production/router.ts";
import type { ImageGenerationInput, ImageGenerationOutcome, ProductionImageProvider } from "../production/image-providers.ts";

// A 1x1 PNG. The durable artifact path verifies it by its magic bytes, as it would any provider image.
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const PNG = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

export type Behaviour = "ready" | "failed" | "not-connected";

export async function studioTenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-dur-${suffix}`;
  const organizationId = `org-dur-${suffix}`;
  const brandId = `brand-dur-${suffix}`;
  const briefId = `brief-dur-${suffix}`;
  const decisionId = `jev-dur-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Fixture User', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${userId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${suffix}`}, ${organizationId}, ${userId}, 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${userId})`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${organizationId}, ${brandId}, ${briefId}, 'opportunity_gate.v2', '2', 'brief', ${briefId},
      '{}', '[]', 0.95, 0.9, '{}', 'AUTO_APPROVE', '[]'
    )
  `;
  await sql`
    insert into briefs (
      id, organization_id, brand_id, title, angle, hook, format, context_pack, workflow, why, status, decision_id, created_by
    ) values (
      ${briefId}, ${organizationId}, ${brandId}, 'Kitchen sponge', 'live demonstration', 'Tired of smelly sponges?',
      'image', '{}', '{}', 'fixture', 'ready', ${decisionId}, ${userId}
    )
  `;
  return { userId, organizationId, brandId, briefId, decisionId };
}

/**
 * Replaces the Google image provider for one test. It stands in for the external call only: everything around the call is
 * the real lifecycle. Each call records what the database held at that moment, which is what "before the provider is
 * called" means in the tests below.
 */
export function stubGoogleImage(sql: Sql, orgId: string, behaviour: Behaviour | ((seed: string) => Behaviour)) {
  const calls: Array<{ jobStatuses: string[]; reservationStatuses: string[]; input: ImageGenerationInput }> = [];
  const stub: ProductionImageProvider = {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false },
    async health() {
      return { id: "google_nano_banana", state: "CONFIGURED", capabilities: ["text-to-image"], detail: "stub", checkedAt: new Date().toISOString() };
    },
    async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
      const jobs = await sql<{ status: string }>`
        select status from production_jobs where organization_id = ${orgId} and modality = 'image'
      `;
      const reservations = await sql<{ status: string }>`
        select status from budget_reservations where organization_id = ${orgId}
      `;
      calls.push({ jobStatuses: jobs.map((row) => row.status), reservationStatuses: reservations.map((row) => row.status), input });
      const outcomeFor = typeof behaviour === "function" ? behaviour(input.seed) : behaviour;
      if (outcomeFor === "failed") return { status: "failed", provider: "google:nano-banana", error: "scripted provider failure" };
      if (outcomeFor === "not-connected") {
        return { status: "NOT_CONNECTED", provider: "google:nano-banana", error: "Google image credentials are not configured (stub)." };
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
      };
    },
  };
  const original = productionRouter.getImage("google_nano_banana");
  productionRouter.registerImage(stub);
  return {
    calls,
    restore() {
      if (original) productionRouter.registerImage(original);
    },
  };
}

export function imagePlan(decisionId: string, options: { maxSpendUsd?: number } = {}) {
  return CreativeDecisionEngine.createPlan({
    lineage: { decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "google_nano_banana",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      decisionId,
    },
    constraints: options.maxSpendUsd === undefined ? {} : { maxSpendUsd: options.maxSpendUsd },
  });
}

export async function insertExecutingPlan(sql: Sql, tenant: Awaited<ReturnType<typeof studioTenant>>, plan: ReturnType<typeof imagePlan>, approvedBy: string | null) {
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, approved_by
    ) values (
      ${plan.id}, ${tenant.organizationId}, ${tenant.brandId}, ${tenant.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}, ${approvedBy}
    )
  `;
}

export async function jobsOf(sql: Sql, planId: string) {
  return sql<{ id: string; status: string; error_code: string | null; artifact_id: string | null; materialized_at: unknown; cost_status: string | null; estimated_cost_cents: number | null; modality: string }>`
    select id, status, error_code, artifact_id, materialized_at, cost_status, estimated_cost_cents, modality
    from production_jobs where creative_plan_id = ${planId} order by created_at asc, id asc
  `;
}

export async function reservationsOf(sql: Sql, orgId: string) {
  return sql<{ id: string; production_job_id: string | null; amount_micros: string | number | bigint; status: string; settled_spend_micros: string | number | bigint | null; cost_basis: string | null; estimator_version: string | null }>`
    select id, production_job_id, amount_micros, status, settled_spend_micros, cost_basis, estimator_version from budget_reservations
    where organization_id = ${orgId} order by created_at asc, id asc
  `;
}
