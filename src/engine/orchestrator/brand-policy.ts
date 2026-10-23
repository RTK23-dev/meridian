// A brand's policy may only switch model families off (owner direction 2026-10-23, decision D16; migration 0119). The workspace policy is one
// global set (policy-store.ts). A brand adds families to it, and the effective set of a plan is the union of the two, so a brand cannot switch
// on a family the workspace has switched off. A plan with no brand uses the workspace set alone.
//
// Every read and write is scoped to the organization. The caller checks the role: this file does not. The family rule is the one
// policy-store.ts applies, copied here so this file does not depend on a file that is changing.

import { z } from "zod";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { normalizeModelId } from "../config/model-policy.ts";

/** The most families one brand may switch off. The same limit policy-store.ts sets on the workspace's list. */
const MAX_FAMILIES = 20;

/** A family is a vendor, or a vendor and a model prefix, as OpenRouter writes ids. Checked after normalizeModelId, as policy-store.ts does. */
const familySchema = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i, "a family is a vendor, or a vendor/model prefix");

function boundedText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw new Error(`${label} must be 1 to ${max} characters.`);
  return trimmed;
}

function uniqueSorted(families: readonly string[]): string[] {
  return [...new Set(families)].sort();
}

/**
 * The families in their stored form: normalized (lowercase, no leading ~), then checked. Throws on the first family that is not a vendor or a
 * vendor/model prefix, and on a list longer than the limit. An invalid list is refused, never trimmed: dropping a family would switch it on.
 */
function checkedFamilies(families: readonly string[]): string[] {
  const normalized = families.map((family) => normalizeModelId(family));
  if (normalized.length > MAX_FAMILIES) throw new Error(`A brand may switch off at most ${MAX_FAMILIES} model families.`);
  for (const family of normalized) {
    if (!familySchema.safeParse(family).success) {
      throw new Error(`"${family.slice(0, 120)}" is not a model family: a family is a vendor, or a vendor/model prefix.`);
    }
  }
  return normalized;
}

/**
 * The families a plan of a brand is held to: the workspace's switched-off families and the brand's, as one list. Unique, sorted and normalized.
 * A family the workspace has switched off is always in the result, so no brand can switch it on. Throws on an invalid family. Pure.
 */
export function effectiveDisabledFamilies(workspaceFamilies: readonly string[], brandFamilies: readonly string[]): string[] {
  return uniqueSorted([...checkedFamilies(workspaceFamilies), ...checkedFamilies(brandFamilies)]);
}

/**
 * The families a brand switches off, as stored. Empty when the brand has no stored policy. A stored list that does not check is refused:
 * an empty read would drop the brand's families, and so switch them on.
 */
export async function readBrandPolicy(sql: Sql, organizationId: string, brandId: string): Promise<string[]> {
  const id = boundedText(brandId, "The brand", 200);
  const rows = (await sql`
    select disabled_model_families::text as families_json from orchestrator_brand_policies
    where organization_id = ${organizationId} and brand_id = ${id} limit 1
  `) as Array<{ families_json: string | null }>;
  const row = rows[0];
  if (row === undefined) return [];
  let stored: unknown = null;
  try {
    stored = row.families_json === null ? null : (JSON.parse(row.families_json) as unknown);
  } catch {
    stored = null;
  }
  if (!Array.isArray(stored) || !stored.every((family) => typeof family === "string")) {
    throw new Error("The stored policy of this brand does not validate, so a plan of this brand cannot be checked against it.");
  }
  return uniqueSorted(checkedFamilies(stored));
}

/**
 * Stores the families a brand switches off, for the brand of the organization. The list is normalized and checked first, and a list that does
 * not check writes nothing. Returns the list as stored.
 */
export async function writeBrandPolicy(
  sql: Sql,
  input: { organizationId: string; brandId: string; actorId: string; disabledModelFamilies: readonly string[] },
): Promise<string[]> {
  const brandId = boundedText(input.brandId, "The brand", 200);
  const actorId = boundedText(input.actorId, "The signed-in user", 200);
  const families = uniqueSorted(checkedFamilies(input.disabledModelFamilies));
  await sql`
    insert into orchestrator_brand_policies (organization_id, brand_id, disabled_model_families, updated_by, updated_at)
    values (${input.organizationId}, ${brandId}, ${JSON.stringify(families)}::jsonb, ${actorId}, now())
    on conflict (organization_id, brand_id) do update set
      disabled_model_families = excluded.disabled_model_families,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
  return families;
}
