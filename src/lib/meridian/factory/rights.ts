/**
 * The rights a person records on a creative (NORTH_STAR section 2, decision B, and the owner's decision on the AI label). A person
 * attests the music and the footage licence for a creative, and confirms the AI label for a variant. The rights gate reads the active
 * records for the creatives a variant made. The gate's rules are in gates.ts and do not change here. A revoke keeps the row, so the
 * record of who recorded it and when is never lost.
 *
 * This file reads and computes. The attest, confirm and revoke actions are in rights-service.ts, which checks the role and the tenant.
 */
import type { Sql } from "../learning/store.ts";
import { rightsGate } from "./gates.ts";
import { isRightsKind, type RightsKind } from "./rights-wording.ts";

export {
  AI_LABEL_KIND,
  ATTESTATION_WORDING,
  LICENCE_KINDS,
  RIGHTS_KINDS,
  isLicenceKind,
  isRightsKind,
  type LicenceKind,
  type RightsKind,
} from "./rights-wording.ts";

/** The active record id of each kind for one creative, or null where that kind is not recorded. */
export type CreativeLicences = Record<RightsKind, string | null>;

function noRecords(): CreativeLicences {
  return { music: null, footage: null, ai_label: null };
}

/** Reads the active records of this brand for the given creatives. A revoked row is never returned, and another brand's is never read. */
export async function licencesForCreatives(
  sql: Sql,
  organizationId: string,
  brandId: string,
  creativeIds: readonly string[],
): Promise<Map<string, CreativeLicences>> {
  const result = new Map<string, CreativeLicences>();
  if (creativeIds.length === 0) return result;
  const wanted = new Set(creativeIds);
  const rows = await sql<{ id: string; asset_id: string; kind: string }>`
    select id, asset_id, kind from rights_attestations
    where organization_id = ${organizationId} and brand_id = ${brandId} and revoked_at is null
  `;
  for (const row of rows) {
    if (!wanted.has(row.asset_id) || !isRightsKind(row.kind)) continue;
    const current = result.get(row.asset_id) ?? noRecords();
    current[row.kind] = row.id;
    result.set(row.asset_id, current);
  }
  return result;
}

/** The creatives a variant made, in this brand. A variant that made none has no creative to record a right on. */
export async function creativeIdsOfVariant(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<string[]> {
  const rows = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives
    where variant_id = ${variantId} and organization_id = ${organizationId} and brand_id = ${brandId}
    order by format asc, creative_id asc
  `;
  return rows.map((row) => row.creative_id);
}

/**
 * Whether each right holds for a variant. A right counts only when every creative of the variant carries it. A variant with no creative
 * carries none, so it is blocked, never passed.
 */
export function variantLicenceFlags(
  creativeIds: readonly string[],
  licences: ReadonlyMap<string, CreativeLicences>,
): { musicLicensed: boolean; footageLicensed: boolean; aiLabeled: boolean } {
  const everyCreative = (kind: RightsKind) => creativeIds.length > 0 && creativeIds.every((id) => licences.get(id)?.[kind] != null);
  return {
    musicLicensed: everyCreative("music"),
    footageLicensed: everyCreative("footage"),
    aiLabeled: everyCreative("ai_label"),
  };
}

/** The rights state of one variant, for the Factory screen. */
export type VariantRights = {
  /** The reason the rights gate blocks the variant, or null when it does not block it. A missing licence is named first. */
  blockedBy: string | null;
  /** The AI-label confirmation. It can be confirmed only when the variant has a creative to label. */
  aiLabel: { confirmed: boolean; canConfirm: boolean };
  /** Each creative of the variant, with the record id of each licence it holds, or null where that licence is not recorded. */
  creatives: Array<{ creativeId: string; music: string | null; footage: string | null }>;
};

/**
 * The rights gate's reason for a variant, for the Factory screen. The licence reasons come first, then the AI label. The gate's rules are
 * the same as the worker's, so the screen and the stored gate result agree.
 */
export function variantRightsView(creativeIds: readonly string[], licences: ReadonlyMap<string, CreativeLicences>): VariantRights {
  const flags = variantLicenceFlags(creativeIds, licences);
  const verdict = rightsGate({ musicLicensed: flags.musicLicensed, footageLicensed: flags.footageLicensed, aiLabeled: flags.aiLabeled });
  return {
    blockedBy: verdict.result === "block" ? verdict.reason : null,
    aiLabel: { confirmed: flags.aiLabeled, canConfirm: creativeIds.length > 0 },
    creatives: creativeIds.map((creativeId) => ({
      creativeId,
      music: licences.get(creativeId)?.music ?? null,
      footage: licences.get(creativeId)?.footage ?? null,
    })),
  };
}
