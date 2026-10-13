/**
 * The Produce stage through the production router (NORTH_STAR section 8, item 6). Each variant of the run is materialized for each
 * format the run makes. The production router chooses the provider, or the run names one. The budget is reserved before the provider
 * is called (contract 5.2). The image is stored and verified, judged and recorded by the materializer Studio uses, so the creative is
 * in creative_records and its review is in reviews: Library and Reviews read it. factory_creatives links it to its run and variant.
 *
 * Only images are produced so far. A run whose formats include video or carousel stops here, before any spend. The video path
 * completes asynchronously through the poller, and the Factory does not wait on it yet.
 *
 * A provider is called once per variant and format. A call that returns a failure releases its reservation. A call that does not
 * return at all keeps its reservation held for a person to release: an expired or unknown submission is never released by the system.
 * A provider that reports a cost writes one metered factory_costs row. A provider that reports none writes none.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { withTransaction } from "../learning/store.ts";
import { loadBrandContext } from "../context/load.ts";
import { qcBrandOf } from "../studio/image-qc.server.ts";
import { completeProductionJob, settleProductionReservation } from "../production/materialization.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { productionRouter } from "../production/router.ts";
import type { ImageGenerationOutcome, ProductionImageProvider } from "../production/image-providers.ts";
import type { CreativeSpec } from "../production/types.ts";
import { BudgetLedgerService, toMicros } from "../security/budget-ledger.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { ArtifactDrive } from "../storage/artifact-drive.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { parseStoredPlan } from "./plan.ts";
import { capStopReason } from "./stage-decision.ts";
import { meteredSpendOf } from "./spend.ts";

/**
 * The guard reserved against one image before its provider call, in USD. It is a ceiling, not a price: no image price is declared for
 * the providers, and a provider that reports no cost settles at this ceiling (unpriced-ceiling-v1). It is the same guard the Studio
 * attach uses. It is an operator value to confirm.
 */
export const FACTORY_IMAGE_CEILING_USD = 1;

/** The version of the image prompt this stage writes. It is recorded on each asset. */
const PROMPT_VERSION = "factory-image-v1";

export type ProduceInput = {
  organizationId: string;
  brandId: string;
  runId: string;
  formats: string[];
  /** Per format: "auto", or a provider id the run names. A named provider that is not ready stops the run. */
  providers: Partial<Record<string, string>>;
  /** The caps the run is held to, in cents, after the run and the brand are combined. Null for a cap that is not set. */
  caps: { totalCents: number | null; dailyCents: number | null };
  /** Decision engines the image judgment may call. Absent means the engines the deployment selects. */
  engines?: DecisionEngineRegistry;
  driveClient?: ArtifactDrive;
};

export type ProduceOutcome = {
  /** Creatives this call linked to the run, including any it finished from an earlier call. */
  produced: number;
  /** The reason the run stops here, or null when every variant was handled. */
  stop: string | null;
};

type VariantRow = {
  id: string;
  template_id: string;
  hook: string;
  cta: string;
  proof: string;
  angle: string;
  tests_attribute: string;
  plan: string;
};

type Step =
  | { kind: "linked" }
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "stop"; reason: string };

type Scope = { organizationId: string; brandId: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A cost the provider reported, in cents. Anything else is no cost, and is not recorded. */
function reportedCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Cents as micro-units of USD. One cent is 10,000 micros. */
function centsToMicros(cents: number): bigint {
  return BigInt(Math.round(cents * 10_000));
}

/** Who approved the production step: the person who approved the stage, or the person who started the run. */
async function approverOf(sql: Sql, scope: Scope, runId: string): Promise<string> {
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
async function recordPlan(sql: Sql, scope: Scope, plan: CreativePlan, approvedBy: string): Promise<void> {
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
async function markJob(sql: Sql, scope: Scope, jobId: string, status: "FAILED" | "SUBMISSION_UNKNOWN", code: string, message: string) {
  await sql`
    update production_jobs
    set status = ${status}, error_code = ${code}, error_message = ${message.slice(0, 500)}, updated_at = now()
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
}

/** Records the link between a variant, its format and the creative the materializer made for it. The first link wins. */
async function linkCreative(
  sql: Sql,
  scope: Scope,
  link: { runId: string; variantId: string; format: string; creativeId: string; jobId: string; provider: string },
): Promise<void> {
  await sql`
    insert into factory_creatives (organization_id, brand_id, run_id, variant_id, format, creative_id, production_job_id, provider, created_at)
    values (${scope.organizationId}, ${scope.brandId}, ${link.runId}, ${link.variantId}, ${link.format}, ${link.creativeId},
      ${link.jobId}, ${link.provider}, now())
    on conflict (variant_id, format) do nothing
  `;
}

/**
 * Finishes one production job: the materializer stores the creative, judges it, opens its review and settles its reservation. A
 * failure here is returned, not thrown, so the run stops with the reason. The job stays COMPLETED, and the next run of this stage
 * finishes it from what is stored.
 */
async function materialize(
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
    return { reason: `The image was stored, but its creative could not be recorded: ${errorText(error)} It is finished the next time this stage runs.` };
  }
}

/**
 * Produces the creative for one variant and format. A variant that already has its creative is skipped. A job that was stored but not
 * recorded is finished. Otherwise the provider is chosen, the budget is reserved, the provider is called once, and the image is stored
 * and recorded.
 */
async function produceOne(
  sql: Sql,
  input: ProduceInput,
  item: { variant: VariantRow; plan: CreativePlan; index: number; format: string; qcBrand: ReturnType<typeof qcBrandOf> },
): Promise<Step> {
  const { variant, plan, index, format, qcBrand } = item;
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const linked = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives where variant_id = ${variant.id} and format = ${format} limit 1
  `;
  if (linked[0]) return { kind: "skipped" };

  const jobId = `factory-${variant.id}-${format}`.slice(0, 180);
  const existing = await sql<{ status: string; provider: string; materialized_creative_id: string | null }>`
    select status, provider, materialized_creative_id from production_jobs
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  const productName = plan.productionContext?.productName ?? "";
  if (existing[0]) {
    // The job exists from an earlier run of this stage. A job whose creative is recorded is linked. A job that completed and was not
    // recorded is finished. Any other job is held or failed, and is left for a person to see on the Factory screen.
    const provider = existing[0].provider;
    if (existing[0].materialized_creative_id) {
      await linkCreative(sql, scope, { runId: input.runId, variantId: variant.id, format, creativeId: existing[0].materialized_creative_id, jobId, provider });
      return { kind: "linked" };
    }
    if (existing[0].status === "COMPLETED") {
      const made = await materialize(sql, input, jobId);
      if ("reason" in made) return { kind: "stop", reason: made.reason };
      await linkCreative(sql, scope, { runId: input.runId, variantId: variant.id, format, creativeId: made.creativeId, jobId, provider });
      return { kind: "linked" };
    }
    return { kind: "skipped" };
  }

  // The caps are checked before a provider call, against the metered spend recorded so far.
  const spend = await meteredSpendOf(sql, scope.organizationId, scope.brandId, input.runId);
  const reached = capStopReason({
    capCents: input.caps.totalCents,
    spentCents: spend.totalCents,
    dailyCapCents: input.caps.dailyCents,
    dailySpentCents: spend.dailyCents,
  });
  if (reached) return { kind: "stop", reason: reached };

  // The copy is the product name, and the one line the brain supplied for the attribute this variant changes. A control changes
  // nothing, so its copy is the product name alone. No line is invented.
  const brainLine =
    variant.tests_attribute === "hook" ? variant.hook : variant.tests_attribute === "cta" ? variant.cta : variant.tests_attribute === "proof" ? variant.proof : "";
  const copy = [productName, brainLine].filter((line) => line.trim()).join("\n");
  const label = `${plan.selectedConceptId ?? "Factory"} · ${variant.tests_attribute || "control"}`;
  const deliverable = plan.deliverables.find((entry) => entry.kind === "image");
  const baseSpec: CreativeSpec = {
    id: jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    title: label,
    modality: "image",
    format: "single_image",
    aspectRatio: "1:1",
    durationTargetSeconds: 0,
    hookLine: variant.hook,
    script: copy,
    scenes: [],
    idempotencyKey: jobId,
  };
  // A named provider is checked first. A provider that is not configured, or not connected, is refused with its reason, and no
  // reservation or call follows. An automatic choice may use a provider with no declared price only against a cap, and the cap is the
  // reservation's bound.
  const requested = input.providers[format] ?? "auto";
  const hasCap = input.caps.totalCents !== null || input.caps.dailyCents !== null;
  let selected: Awaited<ReturnType<typeof productionRouter.selectImageForSpec>>;
  try {
    selected = await productionRouter.selectImageForSpec(baseSpec, { requestedProvider: requested, allowUnknownCost: hasCap });
  } catch (error) {
    return { kind: "stop", reason: errorText(error) };
  }
  const chosen: ProductionImageProvider = selected.provider;
  const modelId = selected.selection.chosen?.modelId ?? "";
  const creativeSpec: CreativeSpec = { ...baseSpec, providerId: chosen.id, modelId };
  const prompt = [productName, variant.angle ? `Angle: ${variant.angle}.` : "", copy].filter(Boolean).join(" ");
  const jobInput = {
    kind: "factory_image",
    runId: input.runId,
    factoryVariantId: variant.id,
    prompt,
    copy,
    productName,
    format: "single_image",
    itemLabel: label,
    sequenceIndex: index,
    manifest: { brand: { product: productName }, hook: { type: variant.hook }, concept: { mechanism: plan.selectedConceptId ?? "" } },
    creativeSpec,
    qcBrand,
    deliverableKind: "image",
    planDeliverableId: deliverable?.id ?? "",
    promptVersion: PROMPT_VERSION,
  };

  // The job row and its reservation are written together. A budget that cannot cover the reservation refuses it, the job row rolls back
  // with it, and no provider is called.
  let reservationId: string;
  try {
    reservationId = await withTransaction(sql, async (tx) => {
      await tx`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
          status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, next_poll_at, modality, cost_status,
          creative_plan_id
        ) values (
          ${jobId}, ${scope.organizationId}, ${scope.brandId}, ${chosen.id}, null, null, null, null,
          'SUBMITTING', 'BALANCED', null, ${JSON.stringify(jobInput)}, now(), null, now(), now() + interval '5 minutes', 'image', 'unknown',
          ${plan.id}
        )
      `;
      const reservation = await BudgetLedgerService.reserve(tx, {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        amountMicros: toMicros(FACTORY_IMAGE_CEILING_USD),
        productionJobId: jobId,
      });
      return reservation.id;
    });
  } catch (error) {
    return { kind: "stop", reason: `The brand's budget cannot cover the next image, so no provider was called. ${errorText(error)}` };
  }

  // The provider is called once. A thrown call may have reached the provider, so its reservation is held for a person.
  const amount = `$${FACTORY_IMAGE_CEILING_USD.toFixed(2)}`;
  let outcome: ImageGenerationOutcome;
  try {
    outcome = await chosen.generate({
      prompt,
      seed: jobId,
      promptVersion: PROMPT_VERSION,
      model: modelId,
      aspectRatio: "1:1",
      organizationId: scope.organizationId,
    });
  } catch (error) {
    const message = errorText(error);
    await markJob(sql, scope, jobId, "SUBMISSION_UNKNOWN", "PROVIDER_CALL_AMBIGUOUS", message);
    return {
      kind: "stop",
      reason: `The ${chosen.id} call did not return, so its outcome is unknown. The ${amount} reserved for it is held until a person releases it. ${message}`,
    };
  }
  if (outcome.status === "NOT_CONNECTED") {
    // The provider made no request, so nothing was billed and the reservation is released. The run stops: the provider is not ready.
    await markJob(sql, scope, jobId, "FAILED", "NOT_CONNECTED", outcome.error);
    await BudgetLedgerService.release(sql, { reservationId, reason: outcome.error });
    return { kind: "stop", reason: outcome.error };
  }
  if (outcome.status === "failed") {
    // The call returned a failure, so it is over, and its reservation is released.
    await markJob(sql, scope, jobId, "FAILED", "PROVIDER_CALL_FAILED", outcome.error);
    await BudgetLedgerService.release(sql, { reservationId, reason: outcome.error });
    return { kind: "failed" };
  }

  // The provider returned an image. If it reported a cost, the reservation settles at that cost and the cost is written as a metered
  // row. If it reported none, nothing is written, and the reservation settles at its ceiling when the creative is recorded.
  const reported = reportedCents(outcome.costCents);
  if (reported !== null) {
    await BudgetLedgerService.reconcile(sql, { reservationId, cost: { basis: "PROVIDER_ACTUAL", amountMicros: centsToMicros(reported) } });
    await sql`
      insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, created_at)
      values (${randomUUID()}, ${scope.organizationId}, ${scope.brandId}, ${input.runId}, 'factory.produce', ${Math.round(reported)}, 0,
        ${chosen.id}, ${jobId}, 'provider_reported', now())
    `;
  }
  await sql`
    update production_jobs
    set output = ${JSON.stringify({
      width: outcome.width,
      height: outcome.height,
      mediaType: outcome.mediaType,
      promptVersion: outcome.promptVersion,
      model: outcome.model,
      provider: outcome.provider,
    })}, updated_at = now()
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
  const stored = await finalizeProductionArtifact(sql, {
    jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    provider: outcome.provider,
    rawArtifact: { bytes: outcome.bytes, mimeType: outcome.mediaType },
    options: input.driveClient ? { driveClient: input.driveClient } : undefined,
  });
  if (!stored.success || !stored.artifactId || !stored.storageKey || !stored.sha256 || stored.byteSize === undefined) {
    // The provider made the image, so the spend happened. The reservation settles, and the job says why it was not stored.
    const reason = stored.error ?? "The image could not be stored.";
    await markJob(sql, scope, jobId, "FAILED", stored.errorCode ?? "STORAGE_PERSISTENCE_FAILED", reason);
    await settleProductionReservation(sql, { organizationId: scope.organizationId, brandId: scope.brandId, productionJobId: jobId });
    return { kind: "stop", reason: `The image was generated, but it was not stored. ${reason}` };
  }

  const made = await materialize(sql, input, jobId);
  if ("reason" in made) return { kind: "stop", reason: made.reason };
  await linkCreative(sql, scope, { runId: input.runId, variantId: variant.id, format, creativeId: made.creativeId, jobId, provider: chosen.id });
  return { kind: "linked" };
}

/**
 * Materializes every variant of the run for each format the run makes (NORTH_STAR section 8, item 6). Variants are taken in the order
 * the Plan stage wrote them. Returns how many creatives the run now has, and the reason it stops, if it does.
 */
export async function produceFactoryCreatives(sql: Sql, input: ProduceInput): Promise<ProduceOutcome> {
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const variants = await sql<VariantRow>`
    select v.id, v.template_id, v.hook, v.cta, v.proof, v.angle, v.tests_attribute, t.plan
    from factory_variants v
    join factory_templates t on t.id = v.template_id and t.organization_id = v.organization_id
    where v.organization_id = ${scope.organizationId} and v.brand_id = ${scope.brandId}
      and t.id like ${`tpl:${input.runId}:%`} and t.plan <> ''
    order by v.created_at asc, v.id asc
  `;
  if (variants.length === 0) return { produced: 0, stop: null };
  // A run with variants to make stops here when it asks for a format that is not produced yet, before any spend. A run with nothing
  // to make has nothing to stop.
  const unsupported = input.formats.filter((format) => format !== "image");
  if (unsupported.length > 0) {
    return {
      produced: 0,
      stop: `The Factory produces images so far. ${unsupported.join(" and ")} is not routed through it yet, so nothing was spent. Start the run with image as its format.`,
    };
  }
  const qcBrand = qcBrandOf(await loadBrandContext(sql, scope.organizationId, scope.brandId));
  const approver = await approverOf(sql, scope, input.runId);

  let produced = 0;
  for (const [index, variant] of variants.entries()) {
    const stored = parseStoredPlan(variant.plan);
    if (!stored) continue;
    await recordPlan(sql, scope, stored.creativePlan, approver);
    for (const format of input.formats) {
      const step = await produceOne(sql, input, { variant, plan: stored.creativePlan, index, format, qcBrand });
      if (step.kind === "stop") return { produced, stop: step.reason };
      if (step.kind === "linked") produced += 1;
    }
  }
  return { produced, stop: null };
}
