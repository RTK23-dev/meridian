/**
 * The pieces every Factory production path shares (NORTH_STAR section 8, item 6): the input a produce run carries, the outcome of one
 * variant and format, the link between a creative and its run, the caps check, and the call that finishes a completed job. The image,
 * video and carousel paths are in produce-image.ts, produce-video.ts and produce-carousel.ts. produce.ts chooses between them.
 */
import type { Sql } from "../learning/store.ts";
import { withTransaction } from "../learning/store.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { ArtifactDrive } from "../storage/artifact-drive.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { completeProductionJob } from "../production/materialization.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { capStopReason } from "./stage-decision.ts";
import { meteredSpendOf } from "./spend.ts";

export type ProduceInput = {
  organizationId: string;
  brandId: string;
  runId: string;
  formats: string[];
  /** Per format: "auto", or a provider id the run names. A named provider that is not ready stops the run. */
  providers: Partial<Record<string, string>>;
  /** The caps the run is held to, in cents, after the run and the brand are combined. Null for a cap that is not set. */
  caps: { totalCents: number | null; dailyCents: number | null };
  /** Decision engines the judgments may call. Absent means the engines the deployment selects. */
  engines?: DecisionEngineRegistry;
  driveClient?: ArtifactDrive;
};

export type Scope = { organizationId: string; brandId: string };

export type VariantRow = {
  id: string;
  template_id: string;
  hook: string;
  cta: string;
  proof: string;
  angle: string;
  tests_attribute: string;
  plan: string;
};

/**
 * What one variant and format came to. "linked" is a creative the run now has. "skipped" is a job that was already handled or that
 * failed earlier. "failed" is a job that returned a failure for this variant. "stop" stops the run with the reason. "waiting" keeps the
 * run at its produce stage, because a provider job it needs has not finished. Nothing is marked produced for a waiting job.
 */
export type Step =
  | { kind: "linked" }
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "stop"; reason: string }
  | { kind: "waiting"; reason: string };

/** The slide index of a creative that is not a carousel slide. */
export const NOT_A_SLIDE = -1;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A cost the provider reported, in cents. Anything else is no cost, and is not recorded. */
export function reportedCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Cents as micro-units of USD. One cent is 10,000 micros. */
export function centsToMicros(cents: number): bigint {
  return BigInt(Math.round(cents * 10_000));
}

/** Who approved the production step: the person who approved the stage, or the person who started the run. */
export async function approverOf(sql: Sql, scope: Scope, runId: string): Promise<string> {
  const approvals = await sql<{ approved_by: string }>`
    select approved_by from factory_approvals
    where run_id = ${runId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and stage = 'factory.produce'
    limit 1
  `;
  if (approvals[0]?.approved_by) return approvals[0].approved_by;
  const runs = await sql<{ created_by: string }>`
    select created_by from factory_runs where id = ${runId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  return runs[0]?.created_by ?? "";
}

/**
 * The CreativePlan row the materializer reads for lineage and the product name. The plan is the one the Plan stage wrote, so the
 * creative's title, decision and approver come from it. An existing row is left as it is.
 */
export async function recordPlan(sql: Sql, scope: Scope, plan: CreativePlan, approvedBy: string): Promise<void> {
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, selected_concept_id,
      plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, approved_by, approved_at
    ) values (
      ${plan.id}, ${scope.organizationId}, ${scope.brandId}, null, ${plan.version}, 'executing', ${plan.scope}, ${plan.autonomy},
      ${plan.objective}, ${plan.selectedConceptId}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}, ${approvedBy}, now()
    )
    on conflict (id) do nothing
  `;
}

/** Moves a production job to a failed or unresolved state, scoped to its tenant. */
export async function markJob(
  sql: Sql,
  scope: Scope,
  jobId: string,
  status: "FAILED" | "SUBMISSION_UNKNOWN" | "PREFLIGHT_FAILED",
  code: string,
  message: string,
): Promise<void> {
  await sql`
    update production_jobs
    set status = ${status}, error_code = ${code}, error_message = ${message.slice(0, 500)}, updated_at = now()
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
}

/** The creative a variant and format already have, or null. A single image, video or carousel row has slide index -1. */
export async function linkedCreativeOf(sql: Sql, variantId: string, format: string, slideIndex: number): Promise<string | null> {
  const rows = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives
    where variant_id = ${variantId} and format = ${format} and slide_index = ${slideIndex}
    limit 1
  `;
  return rows[0]?.creative_id ?? null;
}

export type CreativeLink = {
  runId: string;
  variantId: string;
  format: string;
  slideIndex: number;
  creativeId: string;
  jobId: string;
  provider: string;
};

/** Records the link between a variant, its format, its slide and the creative the materializer made for it. The first link wins. */
export async function linkCreative(sql: Sql, scope: Scope, link: CreativeLink): Promise<void> {
  await sql`
    insert into factory_creatives (
      organization_id, brand_id, run_id, variant_id, format, slide_index, creative_id, production_job_id, provider, created_at
    )
    values (${scope.organizationId}, ${scope.brandId}, ${link.runId}, ${link.variantId}, ${link.format}, ${link.slideIndex},
      ${link.creativeId}, ${link.jobId}, ${link.provider}, now())
    on conflict (variant_id, format, slide_index) do nothing
  `;
}

/**
 * Finishes one production job: the materializer stores the creative, judges it where it judges that modality, opens its review and
 * settles its reservation. A failure here is returned, not thrown, so the run stops with the reason. The job stays COMPLETED, and the
 * next run of this stage finishes it from what is stored.
 */
export async function materialize(
  sql: Sql,
  input: ProduceInput,
  jobId: string,
): Promise<{ creativeId: string } | { reason: string }> {
  try {
    const made = await completeProductionJob(
      sql,
      { organizationId: input.organizationId, brandId: input.brandId, productionJobId: jobId },
      { driveClient: input.driveClient, engines: input.engines },
    );
    return { creativeId: made.creativeId };
  } catch (error) {
    return { reason: `The creative was stored, but it could not be recorded: ${errorText(error)} It is finished the next time this stage runs.` };
  }
}

/**
 * The reason the run's caps stop a provider call, or null. The caps are checked against the metered spend recorded so far, before
 * every call, so the call that would pass a cap is never made.
 */
export async function capStopOf(sql: Sql, input: ProduceInput, scope: Scope): Promise<string | null> {
  const spend = await meteredSpendOf(sql, scope.organizationId, scope.brandId, input.runId);
  return capStopReason({
    capCents: input.caps.totalCents,
    spentCents: spend.totalCents,
    dailyCapCents: input.caps.dailyCents,
    dailySpentCents: spend.dailyCents,
  });
}

/** The provider job statuses that mean a job is still running at the provider, so the run waits. */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "QUEUED",
  "RUNNING",
  "RENDERING",
  "WAITING_FOR_ARTIFACT",
  "WAITING_FOR_EXTERNAL_ARTIFACT",
  "PENDING_PREFLIGHT",
  "STORAGE_PERSISTENCE_FAILED",
]);

/** A job whose provider outcome is not known. Its reservation is held, and nothing is resubmitted. */
export const UNKNOWN_OUTCOME_STATUSES: ReadonlySet<string> = new Set(["SUBMITTING", "SUBMISSION_UNKNOWN"]);

/** Runs a provider job row and reservation inside one transaction, so a reservation is never held without its job. */
export async function insertJobWithReservation(
  sql: Sql,
  input: { organizationId: string; brandId: string; jobId: string; insertJob: (tx: Sql) => Promise<void>; amountMicros: bigint },
): Promise<string> {
  return withTransaction(sql, async (tx) => {
    await input.insertJob(tx);
    const reservation = await BudgetLedgerService.reserve(tx, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      amountMicros: input.amountMicros,
      productionJobId: input.jobId,
    });
    return reservation.id;
  });
}
