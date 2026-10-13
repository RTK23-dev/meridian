/**
 * Attest and revoke a licence for a creative (NORTH_STAR section 2, decision B). Both are member actions: a member is the role that
 * approves Factory stages and publishes (approveFactoryStage and publishCreativeToChannels). Both check the membership and the tenant
 * before they write, record an audit row, and re-gate the variants that made the creative, so the stored gate result follows the change.
 *
 * A revoke sets revoked_at and keeps the row. A brand's attestation never counts for another brand, because every read and write is
 * scoped to the brand the caller is a member of.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { requireBrandAccess } from "../distribution/service.ts";
import { ATTESTATION_WORDING, isLicenceKind } from "./rights.ts";
import { regateVariantsForCreative } from "./worker.ts";

/** Attests a licence for one creative. Attesting a licence that is already attested returns the existing attestation. */
export async function attestLicence(
  sql: Sql,
  userId: string,
  input: { brandId: string; creativeId: string; kind: string },
): Promise<{ attestationId: string; created: boolean; wording: string }> {
  const access = await requireBrandAccess(sql, userId, input.brandId, "member");
  if (!isLicenceKind(input.kind)) throw new Error("Choose the music or the footage licence to attest.");
  const creativeId = input.creativeId.trim();
  if (!creativeId) throw new Error("Choose the creative whose licence is attested.");

  const creatives = await sql<{ id: string }>`
    select id from creative_records
    where id = ${creativeId} and organization_id = ${access.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!creatives[0]) throw new Error("That creative is not in this brand.");

  const existing = await sql<{ id: string }>`
    select id from rights_attestations
    where organization_id = ${access.organizationId} and brand_id = ${input.brandId} and asset_id = ${creativeId}
      and kind = ${input.kind} and revoked_at is null
    limit 1
  `;
  if (existing[0]) return { attestationId: existing[0].id, created: false, wording: ATTESTATION_WORDING[input.kind] };

  const attestationId = randomUUID();
  const wording = ATTESTATION_WORDING[input.kind];
  await sql`
    insert into rights_attestations (id, organization_id, brand_id, asset_id, kind, attested_by, wording)
    values (${attestationId}, ${access.organizationId}, ${input.brandId}, ${creativeId}, ${input.kind}, ${userId}, ${wording})
  `;
  await writeAudit(sql, {
    organizationId: access.organizationId,
    brandId: input.brandId,
    userId,
    action: "rights.attested",
    attestationId,
    metadata: { kind: input.kind, creativeId },
  });
  await regateVariantsForCreative(sql, access.organizationId, input.brandId, creativeId);
  return { attestationId, created: true, wording };
}

/** Revokes an active attestation. The row is kept with revoked_at set, and the variants of its creative are gated again. */
export async function revokeLicence(
  sql: Sql,
  userId: string,
  input: { brandId: string; attestationId: string },
): Promise<{ attestationId: string; creativeId: string; kind: string }> {
  const access = await requireBrandAccess(sql, userId, input.brandId, "member");
  const attestationId = input.attestationId.trim();
  if (!attestationId) throw new Error("Choose the attestation to revoke.");

  const revoked = await sql<{ asset_id: string; kind: string }>`
    update rights_attestations set revoked_at = now()
    where id = ${attestationId} and organization_id = ${access.organizationId} and brand_id = ${input.brandId}
      and revoked_at is null
    returning asset_id, kind
  `;
  const row = revoked[0];
  if (!row) throw new Error("No active attestation in this brand matches. Nothing was changed.");
  await writeAudit(sql, {
    organizationId: access.organizationId,
    brandId: input.brandId,
    userId,
    action: "rights.revoked",
    attestationId,
    metadata: { kind: row.kind, creativeId: row.asset_id },
  });
  await regateVariantsForCreative(sql, access.organizationId, input.brandId, row.asset_id);
  return { attestationId, creativeId: row.asset_id, kind: row.kind };
}

async function writeAudit(
  sql: Sql,
  input: { organizationId: string; brandId: string; userId: string; action: string; attestationId: string; metadata: Record<string, unknown> },
): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.userId}, ${input.action},
      'rights_attestation', ${input.attestationId}, ${JSON.stringify(input.metadata)})
  `;
}
