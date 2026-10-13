/**
 * Licence attestation for the rights gate (NORTH_STAR section 2, decision B). A person attests, under fixed wording, that they hold the
 * licence for the music or the footage in a creative. The rights gate reads the active attestations for the creatives a variant made.
 * The gate's rules are in gates.ts and do not change here. A revoke keeps the row, so the record of who attested is never lost.
 *
 * This file reads and computes. The attest and revoke actions are in rights-service.ts, which checks the role and the tenant.
 */
import type { Sql } from "../learning/store.ts";
import { rightsGate, type GateVerdict } from "./gates.ts";
import { isLicenceKind, type LicenceKind } from "./rights-wording.ts";

export { ATTESTATION_WORDING, LICENCE_KINDS, isLicenceKind, type LicenceKind } from "./rights-wording.ts";

/** The active attestation id for each licence kind of one creative, or null where that licence is not attested. */
export type CreativeLicences = { music: string | null; footage: string | null };

/** Reads the active attestations of this brand for the given creatives. A revoked row is never returned, and another brand's is never read. */
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
    if (!wanted.has(row.asset_id) || !isLicenceKind(row.kind)) continue;
    const current = result.get(row.asset_id) ?? { music: null, footage: null };
    current[row.kind] = row.id;
    result.set(row.asset_id, current);
  }
  return result;
}

/** The creatives a variant made, in this brand. A variant that made none has no creative to attest. */
export async function creativeIdsOfVariant(sql: Sql, organizationId: string, brandId: string, variantId: string): Promise<string[]> {
  const rows = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives
    where variant_id = ${variantId} and organization_id = ${organizationId} and brand_id = ${brandId}
    order by format asc, creative_id asc
  `;
  return rows.map((row) => row.creative_id);
}

/**
 * Whether a variant's licences are attested. A licence counts only when every creative of the variant carries it. A variant with no
 * creative has no licence, so it is blocked, never passed.
 */
export function variantLicenceFlags(
  creativeIds: readonly string[],
  licences: ReadonlyMap<string, CreativeLicences>,
): { musicLicensed: boolean; footageLicensed: boolean } {
  const attestedForAll = (kind: LicenceKind) =>
    creativeIds.length > 0 && creativeIds.every((id) => licences.get(id)?.[kind] != null);
  return { musicLicensed: attestedForAll("music"), footageLicensed: attestedForAll("footage") };
}

/**
 * The rights gate's reason for a variant, for the Factory screen. The licence reasons come first, so a missing licence is named. When
 * both licences are attested, the gate still reads its AI labelling input, which has no source yet, so the reason says so.
 */
export type VariantRights = {
  /** The reason the rights gate blocks the variant, or null when it does not block it. */
  blockedBy: string | null;
  /** Each creative of the variant, with the attestation id of each licence it holds, or null where that licence is not attested. */
  creatives: Array<{ creativeId: string; music: string | null; footage: string | null }>;
};

export function variantRightsView(creativeIds: readonly string[], licences: ReadonlyMap<string, CreativeLicences>): VariantRights {
  const verdict: GateVerdict = rightsGate({ ...variantLicenceFlags(creativeIds, licences), aiLabeled: false });
  return {
    blockedBy: verdict.result === "block" ? verdict.reason : null,
    creatives: creativeIds.map((creativeId) => ({
      creativeId,
      music: licences.get(creativeId)?.music ?? null,
      footage: licences.get(creativeId)?.footage ?? null,
    })),
  };
}
