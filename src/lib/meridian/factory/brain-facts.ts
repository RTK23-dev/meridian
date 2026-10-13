/**
 * The brand brain as the Factory stages read it. They read the same stored brain the brain screen writes (brain.ts), so every value
 * a stage uses is one the brand entered. An empty field stays empty: nothing here fills a field in, and an attribute the brain does
 * not supply produces no variant (plan.ts).
 */

import type { Sql } from "../learning/store.ts";
import { BRAIN_FIELDS, brainCompleteness, type BrainKey } from "../brain.ts";

export type FactoryBrain = {
  /** Every brain text field, keyed as brain.ts keys them. An empty string is an empty field. */
  values: Record<BrainKey, string>;
  /** The share of brain fields with content, from brainCompleteness. */
  completeness: number;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The brain of one brand in one workspace. A brand with no brain row has every field empty. */
export async function loadFactoryBrain(sql: Sql, organizationId: string, brandId: string): Promise<FactoryBrain> {
  const rows = await sql<Record<string, unknown>>`
    select bb.* from brand_brains bb
    join brands b on b.id = bb.brand_id
    where bb.brand_id = ${brandId} and b.organization_id = ${organizationId} and b.deleted_at is null
    limit 1
  `;
  const row = rows[0] ?? {};
  const values = Object.fromEntries(BRAIN_FIELDS.map((field) => [field.key, text(row[field.column])])) as Record<BrainKey, string>;
  return { values, completeness: brainCompleteness(values).ratio };
}

/**
 * A brain field read as a list of entries: one per line or per semicolon. Each entry is trimmed, empty entries are dropped, and a
 * repeated entry is kept once, in the order the brand wrote it.
 */
export function linesOf(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of value.split(/[\n;]/)) {
    const entry = raw.trim().replace(/^[-*•]\s*/, "");
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}
