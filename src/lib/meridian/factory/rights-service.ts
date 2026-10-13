/**
 * Attest, confirm and revoke the rights on a creative or a variant (NORTH_STAR section 2, decision B, and the owner's decision on the AI
 * label). Every action is a member action: a member is the role that approves Factory stages and publishes (approveFactoryStage and
 * publishCreativeToChannels). Each checks the membership and the tenant before it writes, records an audit row, and gates the affected
 * variants again, so the stored gate result follows the change.
 *
 * A revoke sets revoked_at and keeps the row. Every read and write is scoped to the brand the caller is a member of, so another brand's
 * record never counts.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { requireBrandAccess } from "../distribution/service.ts";
import { AI_LABEL_KIND, ATTESTATION_WORDING, isLicenceKind } from "./rights-wording.ts";
import { creativeIdsOfVariant } from "./rights.ts";
import { regateVariantById, regateVariantsForCreative } from "./worker.ts";

/** Attests a licence for one creative. Attesting a licence that is already attested returns the existing record. */
export async function attestLicence(
  sql: Sql,
  userId: string,
  input: { brandId: string; creativeId: string; kind: string },
): Promise<{ attestationId: string; created: boolean; wording: string }> {
  const access = await requireBrandAccess(sql, userId, input.brandId, "member");
  if (!isLicenceKind(input.kind)) {
    throw new Error(input.kind === AI_LABEL_KIND ? "The AI label is confirmed for a variant, not attested for a creative." : "Choose the music or the footage licence to attest.");
  }
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
    objectType: "rights_attestation",
    objectId: attestationId,
    metadata: { kind: input.kind, creativeId },
  });
  await regateVariantsForCreative(sql, access.organizationId, input.brandId, creativeId);
  return { attestationId, created: true, wording };
}

/** Revokes an active record of any kind. The row is kept with revoked_at set, and the variants of its creative are gated again. */
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
    objectType: "rights_attestation",
    objectId: attestationId,
    metadata: { kind: row.kind, creativeId: row.asset_id },
  });
  await regateVariantsForCreative(sql, access.organizationId, input.brandId, row.asset_id);
  return { attestationId, creativeId: row.asset_id, kind: row.kind };
}

/**
 * Confirms the AI label for one variant: the person records that each creative the variant made is labelled as AI-generated where the
 * platform requires it. A creative that already carries the confirmation is left as it is. A variant with no creative has nothing to
 * label, so it is refused.
 */
export async function confirmAiLabel(
  sql: Sql,
  userId: string,
  input: { brandId: string; variantId: string },
): Promise<{ created: number; creativeCount: number; wording: string }> {
  const access = await requireBrandAccess(sql, userId, input.brandId, "member");
  const variantId = input.variantId.trim();
  if (!variantId) throw new Error("Choose the variant whose AI label is confirmed.");
  const variants = await sql<{ id: string }>`
    select id from factory_variants
    where id = ${variantId} and organization_id = ${access.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!variants[0]) throw new Error("That variant is not in this brand.");
  const creativeIds = await creativeIdsOfVariant(sql, access.organizationId, input.brandId, variantId);
  if (creativeIds.length === 0) throw new Error("This variant has no creative yet, so there is nothing to label.");

  const wording = ATTESTATION_WORDING[AI_LABEL_KIND];
  let created = 0;
  for (const creativeId of creativeIds) {
    const existing = await sql<{ id: string }>`
      select id from rights_attestations
      where organization_id = ${access.organizationId} and brand_id = ${input.brandId} and asset_id = ${creativeId}
        and kind = ${AI_LABEL_KIND} and revoked_at is null
      limit 1
    `;
    if (existing[0]) continue;
    await sql`
      insert into rights_attestations (id, organization_id, brand_id, asset_id, kind, attested_by, wording)
      values (${randomUUID()}, ${access.organizationId}, ${input.brandId}, ${creativeId}, ${AI_LABEL_KIND}, ${userId}, ${wording})
    `;
    created += 1;
  }
  if (created > 0) {
    await writeAudit(sql, {
      organizationId: access.organizationId,
      brandId: input.brandId,
      userId,
      action: "rights.ai_label_confirmed",
      objectType: "factory_variant",
      objectId: variantId,
      metadata: { creativeIds, created },
    });
  }
  await regateVariantById(sql, access.organizationId, input.brandId, variantId);
  return { created, creativeCount: creativeIds.length, wording };
}

/** Revokes the AI-label confirmation of one variant, on every creative it made. The rows are kept. */
export async function revokeAiLabel(
  sql: Sql,
  userId: string,
  input: { brandId: string; variantId: string },
): Promise<{ revoked: number }> {
  const access = await requireBrandAccess(sql, userId, input.brandId, "member");
  const variantId = input.variantId.trim();
  if (!variantId) throw new Error("Choose the variant whose AI label is revoked.");
  const creativeIds = await creativeIdsOfVariant(sql, access.organizationId, input.brandId, variantId);
  if (creativeIds.length === 0) throw new Error("This variant has no creative, so no AI label is confirmed for it.");

  const revoked = await sql<{ id: string }>`
    update rights_attestations set revoked_at = now()
    where organization_id = ${access.organizationId} and brand_id = ${input.brandId} and kind = ${AI_LABEL_KIND}
      and revoked_at is null and asset_id = any(${creativeIds})
    returning id
  `;
  if (revoked.length === 0) throw new Error("No AI label is confirmed for this variant. Nothing was changed.");
  await writeAudit(sql, {
    organizationId: access.organizationId,
    brandId: input.brandId,
    userId,
    action: "rights.ai_label_revoked",
    objectType: "factory_variant",
    objectId: variantId,
    metadata: { creativeIds, revoked: revoked.length },
  });
  await regateVariantById(sql, access.organizationId, input.brandId, variantId);
  return { revoked: revoked.length };
}

async function writeAudit(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    userId: string;
    action: string;
    objectType: string;
    objectId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.userId}, ${input.action},
      ${input.objectType}, ${input.objectId}, ${JSON.stringify(input.metadata)})
  `;
}
