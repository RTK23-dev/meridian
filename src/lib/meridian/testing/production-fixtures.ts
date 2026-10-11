/**
 * Shared fixtures for production-path tests. These are data and provider doubles only. They
 * stub a provider at the router's registration point and inherit every other behavior from the
 * real adapter. The reservation, durable job, finalization, materialization, and plan settlement
 * code under test all run unchanged.
 */
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativePlan } from "../creative/plan.ts";
import type { Sql } from "../learning/store.ts";
import { productionRouter } from "../production/router.ts";
import type { CreativeSpec, ProductionJob, ProductionProvider } from "../production/types.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";

export type SubmitOutcome = (spec: CreativeSpec, submissionIndex: number) => Promise<ProductionJob>;
export type PollOutcome = (providerJobId: string) => Promise<ProductionJob>;

export interface InjectedProvider {
  submitted: CreativeSpec[];
  polled: string[];
  setPoll(outcome: PollOutcome): void;
  restore(): void;
}

/**
 * Replaces one registered production provider with a stub. Submission and polling are scripted;
 * health reports configured. Everything else (capabilities, identity) comes from the real adapter,
 * except the capabilities named in `capabilityOverrides`, which a test uses to model a provider
 * with an undeclared cost.
 */
export function injectProvider(
  providerId: string,
  submit: SubmitOutcome,
  poll?: PollOutcome,
  capabilityOverrides?: Partial<ProductionProvider["capabilities"]>,
): InjectedProvider {
  const original = productionRouter.get(providerId);
  if (!original) throw new Error(`fixture: provider '${providerId}' is not registered`);
  const submitted: CreativeSpec[] = [];
  const polled: string[] = [];
  let pollOutcome: PollOutcome = poll ?? (async () => {
    throw new Error("fixture: no poll outcome scripted");
  });
  const stub = Object.create(original, {
    ...(capabilityOverrides ? { capabilities: { value: { ...original.capabilities, ...capabilityOverrides } } } : {}),
    health: {
      value: async () => ({
        id: providerId,
        state: "HEALTHY",
        capabilities: [],
        detail: "test stub",
        checkedAt: new Date().toISOString(),
      }),
    },
    // A provider with a workspace-scoped check is stubbed on that path too, so the router sees the same readiness.
    healthFor: {
      value: async () => ({
        id: providerId,
        state: "HEALTHY",
        capabilities: [],
        detail: "test stub",
        checkedAt: new Date().toISOString(),
      }),
    },
    submitJob: {
      value: async (spec: CreativeSpec) => {
        const index = submitted.length + 1;
        submitted.push(spec);
        return submit(spec, index);
      },
    },
    checkJobStatus: {
      value: async (jobId: string) => {
        polled.push(jobId);
        return pollOutcome(jobId);
      },
    },
  }) as ProductionProvider;
  productionRouter.register(stub);
  return {
    submitted,
    polled,
    setPoll(outcome) {
      pollOutcome = outcome;
    },
    restore() {
      productionRouter.register(original);
    },
  };
}

export function job(spec: CreativeSpec, status: ProductionJob["status"], fields: Partial<ProductionJob> = {}): ProductionJob {
  return {
    jobId: `job-${spec.idempotencyKey ?? "fixture"}`,
    organizationId: "",
    brandId: "",
    creativeSpec: spec,
    providerId: spec.providerId ?? "",
    status,
    ...fields,
  } as ProductionJob;
}

/** A minimal, valid MP4 container: size box, `ftyp` brand, padding past the artifact minimum. */
export function fakeMp4(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 32], 0);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  return bytes;
}

export interface Tenant {
  organizationId: string;
  brandId: string;
  briefId: string;
  decisionId: string;
  plan: CreativePlan;
  brief: Record<string, unknown>;
}

/**
 * A tenant with an approved brief (JEV AUTO_APPROVE) and an executing CreativePlan. With
 * `copies` above one, the single video deliverable is cloned so one plan creates several jobs.
 */
export async function createTenantFixture(
  sql: Sql,
  label: string,
  planCapUsd: number | null,
  providerId: string,
  modelId: string,
  copies = 1,
): Promise<Tenant> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organizationId = `org-prod-${suffix}`;
  const brandId = `brand-prod-${suffix}`;
  const briefId = `brief-prod-${suffix}`;
  const decisionId = `jev-prod-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
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
      'video', '{}', '{}', 'fixture', 'ready', ${decisionId}, 'test-user'
    )
  `;

  const planned: CreativePlan = CreativeDecisionEngine.createPlan({
    lineage: { decisionId, evidenceRefs: ["ev-fixture-1"] },
      productionContext: { title: "Kitchen sponge", audience: "", angle: "live demonstration", productName: "Mesh sponge", opportunityId: null },
    scope: "video_only",
    autonomy: "semi_automatic",
    preferredVideoProvider: providerId,
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      targetDurationSeconds: 8,
      decisionId,
    },
    constraints: planCapUsd === null ? {} : { maxSpendUsd: planCapUsd },
  });
  if (planned.deliverables.length !== 1 || planned.deliverables[0]!.model !== modelId) {
    throw new Error(`fixture: expected one ${providerId}/${modelId} deliverable, got ${JSON.stringify(planned.deliverables.map((d) => [d.provider, d.model]))}`);
  }
  const plan = copies > 1 ? cloneDeliverables(planned, copies) : planned;

  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective,
      plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, approved_by
    ) values (
      ${plan.id}, ${organizationId}, ${brandId}, ${briefId}, ${plan.version}, 'executing', ${plan.scope}, ${plan.autonomy},
      ${plan.objective}, ${JSON.stringify(plan)}, 0, ${planCapUsd}, ${decisionId}, 'test-user'
    )
  `;

  const brief = {
    id: briefId,
    brand_id: brandId,
    opportunity_id: null,
    title: "Kitchen sponge",
    audience: "",
    angle: "live demonstration",
    decision_id: decisionId,
  };
  return { organizationId, brandId, briefId, decisionId, plan, brief };
}

/** Clones the single video deliverable into `copies` deliverables; the total estimate is split evenly. */
function cloneDeliverables(plan: CreativePlan, copies: number): CreativePlan {
  const [base] = plan.deliverables;
  if (!base) throw new Error("fixture: plan has no deliverable to clone");
  const total = plan.estimatedCost.totalEstimatedUsd;
  const perDeliverableUsd: Record<string, number> = {};
  const deliverables = Array.from({ length: copies }, (_, index) => {
    const id = `${base.id}-copy-${index + 1}`;
    perDeliverableUsd[id] = total / copies;
    return { ...base, id, sequenceIndex: index };
  });
  return {
    ...plan,
    deliverables,
    estimatedCost: { ...plan.estimatedCost, perDeliverableUsd },
  };
}

export async function execute(sql: Sql, tenant: { organizationId: string }, plan: CreativePlan) {
  return executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, "test-user", plan);
}

export async function reservationsFor(sql: Sql, planId: string) {
  return sql<{ id: string; status: string; amount_micros: string | number | bigint; production_job_id: string | null }>`
    select id, status, amount_micros, production_job_id from budget_reservations where creative_plan_id = ${planId} order by created_at, id
  `;
}

export async function accountReservedMicros(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  return (await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId)).reservedMicros;
}

export async function accountSpentMicros(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  return (await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId)).spentMicros;
}

export async function planStatus(sql: Sql, planId: string) {
  const rows = await sql<{ status: string }>`select status from creative_plans where id = ${planId}`;
  return rows[0]?.status;
}

export async function productionJobs(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  return sql<{
    id: string;
    status: string;
    artifact_id: string | null;
    materialized_at: unknown;
    materialized_creative_id: string | null;
    error_message: string | null;
    creative_plan_id: string | null;
  }>`
    select id, status, artifact_id, materialized_at, materialized_creative_id, error_message, creative_plan_id
    from production_jobs where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
    order by created_at, id
  `;
}
