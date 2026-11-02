// Saving the templates and variants of a factory run, and the plan settings they come from. Moved out of factory/worker.ts
// unchanged (coding loop, T5). worker.ts keeps its public names.

import type { Sql } from "../learning/store.ts";
import { CREATIVE_DNA_VERSION, type CreativeDna } from "./creative-dna.ts";
import { loadSavedFactoryPipelineConfig } from "./pipeline-config-store.ts";
import { holdoutItemIds } from "./sleep-holdout.ts";
import { templateFromDna } from "./template.ts";
import { brainEntriesOf, controlAttributesOf, creativePlanFor, parseStoredPlan, storedPlanOf, variantsOf, type PlanAttributes, type PlanRun } from "./plan.ts";
import { conceptOf } from "./pick.ts";
import { linesOf } from "./brain-facts.ts";
import { loadFactoryBrain } from "./brain-facts.ts";

type PlanSettings = PlanRun & {
  video?: { aspectRatio: "9:16" | "1:1" | "16:9" | "4:5"; durationSeconds: number } | null;
  briefPrompt?: string | null;
};

export async function savedPlanLine(sql: Sql, organizationId: string, brandId: string) {
  const line = await loadSavedFactoryPipelineConfig(sql, organizationId, brandId);
  if (!line) return null;
  return {
    video: { aspectRatio: line.generationParams.aspectRatio, durationSeconds: line.generationParams.durationSeconds },
    briefPrompt: line.prompts.briefPrompt,
  };
}

/**
 * The storyboard and the CreativePlan of each pick of this run (NORTH_STAR section 5, plan). The storyboard is the framework of the
 * pick's winning ad, read from its creative DNA. The plan needs the engine decision the ad was graded under, and the brand's product.
 * A pick with neither gets a storyboard and no plan, and the reason is returned, so no variant is written for it.
 */
export async function persistTemplates(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
  settings: PlanSettings,
): Promise<{ templates: number; plans: number; refused: string[] }> {
  const picks = await sql<{
    research_ad_id: string;
    record: string;
    winner_score: number | null;
    jev_gate_record_id: string | null;
    jev_reason: string;
  }>`
    select p.research_ad_id, d.record, t.winner_score, t.jev_gate_record_id, t.jev_reason
    from factory_picks p
    join creative_dna d on d.research_ad_id = p.research_ad_id and d.organization_id = p.organization_id
      and d.brand_id = p.brand_id and d.schema_version = ${CREATIVE_DNA_VERSION}
    left join ad_timelines t on t.research_ad_id = p.research_ad_id and t.organization_id = p.organization_id and t.brand_id = p.brand_id
    where p.run_id = ${runId} and p.organization_id = ${organizationId} and p.brand_id = ${brandId}
    order by p.score desc, p.id
  `;
  const brain = await loadFactoryBrain(sql, organizationId, brandId);
  const product = await sql<{ name: string }>`
    select p.name from products p
    join brands b on b.id = p.brand_id
    where p.brand_id = ${brandId} and b.organization_id = ${organizationId}
    order by p.created_at asc, p.id asc
    limit 1
  `;
  const productName = product[0]?.name ?? "";
  const audience = linesOf(brain.values.targetCustomers)[0] ?? "";
  const now = new Date().toISOString();
  let templates = 0;
  let plans = 0;
  const refused: string[] = [];
  for (const row of picks) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    const concept = dna?.adId ? conceptOf(dna) : null;
    if (!concept) continue;
    const template = templateFromDna(dna);
    const templateId = `tpl:${runId}:${row.research_ad_id}`;
    const attributes = controlAttributesOf(dna);
    let plan = "";
    if (!row.jev_gate_record_id) {
      // No engine decision backs the item, so the plan has no lineage. The grade's own reason is recorded with the refusal.
      refused.push(`${concept.label}: ${row.jev_reason || "no engine decision backs this ad"}`);
    } else {
      try {
        const creativePlan = creativePlanFor({
          templateId,
          concept,
          attributes,
          decisionId: row.jev_gate_record_id,
          researchAdId: row.research_ad_id,
          winnerScore: Number(row.winner_score ?? 0),
          productName,
          audience,
          run: settings,
          now,
          video: settings.video,
          briefPrompt: settings.briefPrompt,
        });
        plan = storedPlanOf(attributes, creativePlan);
        plans += 1;
      } catch (error) {
        refused.push(`${concept.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sql`
      insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard, plan)
      values (${templateId}, ${organizationId}, ${brandId}, ${row.research_ad_id}, ${JSON.stringify(template)}, ${plan})
      on conflict (id) do update set storyboard = excluded.storyboard, plan = excluded.plan
    `;
    templates += 1;
  }
  return { templates, plans, refused };
}

async function variantsMadeToday(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from factory_variants
    where organization_id = ${organizationId} and brand_id = ${brandId} and created_at >= date_trunc('day', now())
  `;
  return rows[0]?.n ?? 0;
}

/**
 * The variants of each planned pick (NORTH_STAR section 5, plan). A pick gets its control, and one variant for each entry the brain
 * supplies, changing one attribute. Every row records the attribute it tests: "control" for the control. The run's variant cap bounds
 * the rows written across all picks, and a pick the cap has no room for gets none.
 */
export async function persistVariants(
  sql: Sql,
  organizationId: string,
  brandId: string,
  runId: string,
  maxVariants: number,
  videosPerConcept: number | null = null,
  dailyCap: number | null = null,
): Promise<number> {
  const templates = await sql<{ id: string; plan: string }>`
    select id, plan from factory_templates
    where organization_id = ${organizationId} and brand_id = ${brandId} and id like ${`tpl:${runId}:%`} and plan <> ''
    order by created_at asc, id asc
  `;
  const brain = await loadFactoryBrain(sql, organizationId, brandId);
  const entries = brainEntriesOf(brain.values);
  const held = holdoutItemIds(await sql<{ item_id: string; arm: string }>`
    select item_id, arm from factory_holdouts
    where organization_id = ${organizationId} and brand_id = ${brandId} and run_id = ${runId}
  `);
  const madeToday = dailyCap === null ? 0 : await variantsMadeToday(sql, organizationId, brandId);
  let dailyRoom = dailyCap === null ? Number.POSITIVE_INFINITY : Math.max(0, dailyCap - madeToday);
  let budget = Math.max(0, maxVariants);
  let count = 0;
  for (const template of templates) {
    if (budget <= 0 || dailyRoom <= 0) break;
    if (held.has(template.id)) continue;
    const stored = parseStoredPlan(template.plan);
    if (!stored) continue;
    const control: PlanAttributes = stored.attributes;
    const room = videosPerConcept === null ? budget : Math.min(budget, Math.max(0, videosPerConcept));
    const rows: Array<{ attribute: string; attributes: PlanAttributes }> = [
      { attribute: "control", attributes: control },
      ...variantsOf(control, entries, Math.max(0, room - 1)).map((variant) => ({ attribute: variant.attribute, attributes: variant.attributes })),
    ].slice(0, room);
    let considered = 0;
    for (const [index, row] of rows.entries()) {
      if (dailyRoom <= 0) break;
      const id = `var:${template.id}:${index}`;
      const inserted = await sql<{ id: string }>`
        insert into factory_variants (
          id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result, tests_attribute, angle, format, proof
        ) values (
          ${id.slice(0, 180)}, ${organizationId}, ${brandId}, ${template.id}, ${row.attributes.hook}, ${row.attributes.cta},
          ${row.attributes.presenter}, ${Math.round(row.attributes.lengthMs)}, 'review', ${row.attribute}, ${row.attributes.angle},
          ${row.attributes.format}, ${row.attributes.proof}
        )
        on conflict (id) do nothing
        returning id
      `;
      considered += 1;
      count += 1;
      if (inserted.length > 0) dailyRoom -= 1;
    }
    budget -= considered;
  }
  return count;
}

/** Claim text is one claim per line or per semicolon. */
