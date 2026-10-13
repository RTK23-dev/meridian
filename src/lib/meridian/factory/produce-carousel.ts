/**
 * The carousel path of the Produce stage (NORTH_STAR section 8, item 3). A carousel is one parent job with one image job for each slide,
 * the same shape Studio makes (production/materialization.ts, settleCarouselParent). The slides come from the existing creative engine's
 * carousel scope (creative/engine.ts), so the number of slides and what each says is the engine's. Each slide is produced through the
 * image path with the run's provider choice, and is judged as an image is. The carousel creative is made when its last slide is stored.
 *
 * The carousel creative itself is not judged separately: it is judged through its slides, as settleCarouselParent says.
 */
import type { Sql } from "../learning/store.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { settleCarouselParent } from "../production/materialization.ts";
import type { qcBrandOf } from "../studio/image-qc.server.ts";
import { produceImage } from "./produce-image.ts";
import {
  NOT_A_SLIDE,
  errorText,
  linkCreative,
  linkedCreativeOf,
  type ProduceInput,
  type Scope,
  type Step,
  type VariantRow,
} from "./produce-shared.ts";

export type CarouselRequest = {
  variant: VariantRow;
  plan: CreativePlan;
  productName: string;
  /** The one line the brain supplied for the attribute this variant changes, or the angle when none. */
  message: string;
  qcBrand: ReturnType<typeof qcBrandOf>;
};

type Slide = { index: number; copy: string; deliverableId: string };

/**
 * The slides of a carousel, from the existing creative engine's carousel scope. The engine takes the plan's lineage and production context,
 * so the slides belong to the same decision as the plan. The same plan always gives the same slides, so a job id made for a slide is
 * found again on a rerun.
 */
export function slidesOf(plan: CreativePlan, variant: VariantRow, productName: string, message: string): Slide[] {
  const created = CreativeDecisionEngine.createPlan({
    lineage: plan.lineage,
    productionContext: plan.productionContext ?? undefined,
    scope: "carousel_only",
    autonomy: plan.autonomy,
    objective: plan.objective,
    conceptId: plan.selectedConceptId ?? undefined,
    brief: {
      title: plan.productionContext?.title ?? "",
      hook: variant.hook,
      message,
      cta: variant.cta,
      angle: variant.angle,
      productName,
      aspectRatio: "1:1",
    },
  });
  // A slide the engine left without words (a control has no line for its CTA, for example) carries the product name alone, as an image's
  // copy does. No line is invented.
  return created.deliverables
    .filter((deliverable) => deliverable.kind === "carousel_slide")
    .map((deliverable, index) => ({ index, copy: deliverable.copy.trim() || productName, deliverableId: deliverable.id }));
}

/** Produces one variant's carousel: its parent job, each slide, and the carousel creative once every slide is stored. */
export async function produceCarousel(sql: Sql, input: ProduceInput, req: CarouselRequest): Promise<Step> {
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const { variant, plan, productName } = req;
  const parentId = `factory-${variant.id}-carousel`.slice(0, 180);

  if (await linkedCreativeOf(sql, variant.id, "carousel", NOT_A_SLIDE)) return { kind: "skipped" };

  let slides: Slide[];
  try {
    slides = slidesOf(plan, variant, productName, req.message);
  } catch (error) {
    return { kind: "stop", reason: errorText(error) };
  }
  if (slides.length === 0) return { kind: "stop", reason: "The creative engine planned no carousel slides for this variant. Nothing was spent." };

  const parents = await sql<{ status: string }>`
    select status from production_jobs
    where id = ${parentId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  if (!parents[0]) {
    // The parent job is written before any slide, so a slide always has a parent to belong to. It holds no reservation: each slide has one.
    await sql`
      insert into production_jobs (
        id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
        status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
        modality, sequence_index, parent_job_id, cost_status
      ) values (
        ${parentId}, ${scope.organizationId}, ${scope.brandId}, 'carousel', null, null, null, null,
        'AWAITING_CHILDREN', 'BALANCED', null,
        ${JSON.stringify({
          kind: "factory_carousel",
          runId: input.runId,
          factoryVariantId: variant.id,
          slideCount: slides.length,
          planDeliverableIds: slides.map((slide) => slide.deliverableId),
          productName,
        })},
        now(), null, now(), ${plan.id}, 'carousel', null, null, null
      )
      on conflict (id) do nothing
    `;
  }

  let failedSlides = 0;
  let linkedSlides = 0;
  for (const slide of slides) {
    if (!slide.copy.trim()) {
      return { kind: "stop", reason: `Carousel slide ${slide.index + 1} has no copy to check, so nothing was sent.` };
    }
    if (await linkedCreativeOf(sql, variant.id, "carousel", slide.index)) continue;
    const step = await produceImage(sql, input, {
      variant,
      plan,
      jobId: `factory-${variant.id}-slide-${slide.index}`.slice(0, 180),
      format: "carousel",
      slideIndex: slide.index,
      sequenceIndex: slide.index,
      copy: slide.copy,
      label: `Slide ${slide.index + 1}`,
      productName,
      hook: variant.hook,
      angle: variant.angle,
      parentJobId: parentId,
      deliverableKind: "carousel_slide",
      planDeliverableId: slide.deliverableId,
      qcBrand: req.qcBrand,
    });
    if (step.kind === "stop") return step;
    if (step.kind === "waiting") return { kind: "stop", reason: step.reason };
    // A slide this call linked counts as one creative of the run, whichever call made its job.
    if (step.kind === "linked") linkedSlides += 1;
    // A slide that failed, or that an earlier run left unfinished, leaves the carousel incomplete.
    if (step.kind === "failed" || step.kind === "skipped") failedSlides += 1;
  }

  if (failedSlides > 0) {
    // The slides that did complete keep their own creatives. The carousel is marked incomplete, and no carousel creative is made.
    await settleCarouselParent(sql, { organizationId: scope.organizationId, brandId: scope.brandId, productionJobId: parentId });
    return { kind: "failed", creatives: linkedSlides };
  }

  // Every slide is stored. The last slide settles the carousel when it is materialized; a carousel that is still pending is settled here.
  const parent = await sql<{ status: string; materialized_creative_id: string | null }>`
    select status, materialized_creative_id from production_jobs
    where id = ${parentId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  if (!parent[0]?.materialized_creative_id) {
    const settled = await settleCarouselParent(sql, { organizationId: scope.organizationId, brandId: scope.brandId, productionJobId: parentId });
    if (settled !== "completed") return { kind: "failed", creatives: linkedSlides };
  }
  const made = await sql<{ materialized_creative_id: string | null }>`
    select materialized_creative_id from production_jobs
    where id = ${parentId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  const carouselCreativeId = made[0]?.materialized_creative_id;
  if (!carouselCreativeId) return { kind: "failed", creatives: linkedSlides };
  await linkCreative(sql, scope, {
    runId: input.runId,
    variantId: variant.id,
    format: "carousel",
    slideIndex: NOT_A_SLIDE,
    creativeId: carouselCreativeId,
    jobId: parentId,
    provider: "carousel",
  });
  // The slides this call linked, and the carousel creative that makes the fifth.
  return { kind: "linked", creatives: linkedSlides + 1 };
}
