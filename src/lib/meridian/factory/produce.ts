/**
 * The Produce stage through the production router (NORTH_STAR section 8, items 3 and 6). Each variant of the run is made for each format
 * the run makes: an image, a video or a carousel. The router chooses the provider, or the run names one, and the budget is reserved before
 * a provider is called (contract 5.2). Images and carousel slides are stored, judged and recorded by the materializer Studio uses, so each
 * creative is in creative_records and its review is in reviews. factory_creatives links it to its run, its variant, its format and its
 * slide.
 *
 * A video is a provider job that can take minutes. While one is at the provider the run waits: it keeps status running, its reason is in
 * error, and waiting_on is set, so the stages after produce do not run. The stage checks again later (scheduleProduceRecheck). Nothing is
 * marked produced until the video is stored and its creative exists.
 *
 * A provider call that returns a failure releases its reservation. A call that does not return at all keeps its reservation held. Once its
 * window has passed, the sweep asks the provider's own lookup whether it holds a job for the submission, and releases the hold only when
 * the provider confirms it holds none (security/held-reservations.ts, releaseExpiredHolds). Otherwise an admin resolves the hold. A
 * submission the provider answered, or that produced a creative, is never released by the sweep.
 */
import type { Sql } from "../learning/store.ts";
import { loadBrandContext } from "../context/load.ts";
import { qcBrandOf } from "../studio/image-qc.server.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { parseStoredPlan } from "./plan.ts";
import { FACTORY_GRAPH } from "./pipeline.ts";
import { produceImage } from "./produce-image.ts";
import { produceVideo } from "./produce-video.ts";
import { produceCarousel } from "./produce-carousel.ts";
import { NOT_A_SLIDE, approverOf, recordPlan, linkedCreativeOf, type ProduceInput, type Scope, type Step, type VariantRow } from "./produce-shared.ts";

export { FACTORY_IMAGE_CEILING_USD } from "./produce-image.ts";
export type { ProduceInput } from "./produce-shared.ts";

export type ProduceOutcome = {
  /** Creatives this call linked to the run, including any it finished from an earlier call. */
  produced: number;
  /** The reason the run stops here, or null when nothing stops it. A stop is recorded as paused. */
  stop: string | null;
  /** The reason the run waits for a provider job that has not finished, or null. A waiting run keeps its status running. */
  waiting: string | null;
};

/** How long a waiting run waits before the stage checks its provider jobs again. The poller reads the jobs on its own schedule. */
export const PRODUCE_RECHECK_SECONDS = 10 * 60;

/**
 * Produces the creatives of one run. Variants are taken in the order the Plan stage wrote them. A waiting video does not stop the other
 * variants and formats: they are produced, and the run waits for the videos that are still at the provider.
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
  if (variants.length === 0) return { produced: 0, stop: null, waiting: null };
  const unknown = input.formats.filter((format) => format !== "image" && format !== "video" && format !== "carousel");
  if (unknown.length > 0) {
    return { produced: 0, stop: `${unknown.join(" and ")} is not a format the Factory makes. Nothing was spent.`, waiting: null };
  }
  const qcBrand = qcBrandOf(await loadBrandContext(sql, scope.organizationId, scope.brandId));
  const approver = await approverOf(sql, scope, input.runId);

  let produced = 0;
  const waits: string[] = [];
  for (const [index, variant] of variants.entries()) {
    const stored = parseStoredPlan(variant.plan);
    if (!stored) continue;
    await recordPlan(sql, scope, stored.creativePlan, approver);
    for (const format of input.formats) {
      const step = await produceVariantFormat(sql, input, { variant, plan: stored.creativePlan, index, format, qcBrand });
      if (step.kind === "stop") return { produced, stop: step.reason, waiting: null };
      if (step.kind === "waiting") waits.push(step.reason);
      if (step.kind === "linked") produced += step.creatives ?? 1;
      if (step.kind === "failed") produced += step.creatives ?? 0;
    }
  }
  const extra = waits.length - 1;
  const waiting = waits.length === 0 ? null : extra === 0 ? (waits[0] ?? null) : `${waits[0]} ${extra} more ${extra === 1 ? "job is" : "jobs are"} waiting as well.`;
  return { produced, stop: null, waiting };
}

/** One variant in one format. Each format has its own path, and each path finds what the run already made before it spends. */
async function produceVariantFormat(
  sql: Sql,
  input: ProduceInput,
  item: { variant: VariantRow; plan: CreativePlan; index: number; format: string; qcBrand: ReturnType<typeof qcBrandOf> },
): Promise<Step> {
  const { variant, plan, index, format, qcBrand } = item;
  const productName = plan.productionContext?.productName ?? "";
  // The copy is the product name, and the one line the brain supplied for the attribute this variant changes. A control changes
  // nothing, so its copy is the product name alone. No line is invented.
  const brainLine =
    variant.tests_attribute === "hook" ? variant.hook : variant.tests_attribute === "cta" ? variant.cta : variant.tests_attribute === "proof" ? variant.proof : "";
  const copy = [productName, brainLine].filter((line) => line.trim()).join("\n");
  const label = `${plan.selectedConceptId ?? "Factory"} · ${variant.tests_attribute || "control"}`;

  if (format === "image") {
    if (await linkedCreativeOf(sql, variant.id, "image", NOT_A_SLIDE)) return { kind: "skipped" };
    return produceImage(sql, input, {
      variant,
      plan,
      jobId: `factory-${variant.id}-${format}`.slice(0, 180),
      format: "image",
      slideIndex: NOT_A_SLIDE,
      sequenceIndex: index,
      copy,
      label,
      productName,
      hook: variant.hook,
      angle: variant.angle,
      parentJobId: null,
      deliverableKind: "image",
      planDeliverableId: plan.deliverables.find((deliverable) => deliverable.kind === "image")?.id ?? "",
      qcBrand,
    });
  }
  if (format === "video") {
    if (await linkedCreativeOf(sql, variant.id, "video", NOT_A_SLIDE)) return { kind: "skipped" };
    const deliverable = plan.deliverables.find((entry) => entry.kind === "video");
    return produceVideo(sql, input, {
      variant,
      plan,
      jobId: `factory-${variant.id}-video`.slice(0, 180),
      label,
      copy,
      productName,
      hook: variant.hook,
      angle: variant.angle,
      planDeliverableId: deliverable?.id ?? "",
      durationSeconds: deliverable?.targetDurationSeconds ?? 8,
      sequenceIndex: index,
    });
  }
  if (format === "carousel") {
    return produceCarousel(sql, input, { variant, plan, productName, message: brainLine || variant.angle, qcBrand });
  }
  return { kind: "stop", reason: `${format} is not a format the Factory makes. Nothing was spent.` };
}

/**
 * Schedules the produce stage again, for a run waiting on a provider job. The new job carries resumeWait, so when it finds the jobs done
 * it queues the stages after produce. It waits PRODUCE_RECHECK_SECONDS before it runs, and a run waiting for a long render checks again
 * each time it runs.
 */
export async function scheduleProduceRecheck(sql: Sql, input: { organizationId: string; brandId: string; runId: string; niche: string }): Promise<void> {
  const spec = FACTORY_GRAPH.find((item) => item.type === "factory.produce");
  if (!spec) throw new Error("This build has no produce step to check again.");
  const id = globalThis.crypto.randomUUID();
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority, run_after)
    values (
      ${id}, ${input.organizationId}, ${input.brandId}, 'factory.produce',
      ${`factory:${input.brandId}:${input.runId}:factory.produce:recheck:${globalThis.crypto.randomUUID()}`},
      'queued',
      ${JSON.stringify({ organizationId: input.organizationId, brandId: input.brandId, runId: input.runId, niche: input.niche, stage: "factory.produce", resumeWait: true })},
      ${spec.maxAttempts}, '', ${20 + FACTORY_GRAPH.indexOf(spec)}, now() + interval '10 minutes'
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
}
