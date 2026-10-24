// Puts a reviewed, rights-cleared repurposed variation into the library as a derived creative: a creative_records row with its origin
// 'generated', and an assets row whose storage key is the variation's own stored video. The link is explicit, idempotent (one creative per
// variation, enforced by a unique index), and it publishes nothing. A creative is marked approved only here, after the same checks the
// variation's approval made, repeated now: a rendered video, a current approval of that exact video, and rights that still cover every file
// the cut was made from. Anything that fails those checks is refused, and nothing is written.

import { randomUUID } from "node:crypto";
import { readArtifact } from "../../../engine/jobs/artifact-store.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { coveringRightsRecordIds, rightsGate } from "./governance.ts";
import { repurposeReviewsOf } from "./repurpose-review.ts";
import { rightsRecordsOf, sessionAccess, storedFilesOf, todayIso } from "./service.ts";

/** The facts a derived creative is made from. All of them were read on the server, for the session's own workspace. */
export type RepurposedVariantSource = {
  organizationId: string;
  brandId: string;
  sessionId: string;
  runId: string;
  variantId: string;
  variantKey: string;
  sessionTitle: string;
  renderedArtifactId: string;
  rightsRecordIds: string[];
};

/**
 * Whether one variation may enter the library and be published: an admin's session, the run it belongs to, a rendered video, the
 * reviewer's current approval of that video, and rights that cover every file it was made from. Reads only.
 */
export async function repurposedVariantSource(
  sql: Sql,
  userId: string,
  input: { sessionId: string; runId: string; variantKey: string },
): Promise<{ ok: true; source: RepurposedVariantSource } | { ok: false; reason: string }> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  if (!session.brand_id) return { ok: false, reason: "This session has no brand, so the variation cannot join its library." };

  const found = await sql<{ id: string; status: string; rendered_artifact_id: string | null }>`
    select v.id, v.status, v.rendered_artifact_id
    from content_factory_repurpose_variants v
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    where v.organization_id = ${session.organization_id} and r.session_id = ${session.id} and v.run_id = ${input.runId} and v.variant_key = ${input.variantKey}
    limit 1
  `;
  const variant = found[0];
  if (!variant) return { ok: false, reason: "That variation is not part of this run. Nothing was changed." };
  if (variant.status !== "rendered" || !variant.rendered_artifact_id) {
    return { ok: false, reason: "Only a rendered variation can join the library. Nothing was changed." };
  }

  const reviews = await repurposeReviewsOf(sql, userId, { sessionId: input.sessionId, runId: input.runId });
  if (reviews[input.variantKey]?.status !== "approved") {
    return { ok: false, reason: "This variation is not approved. Approve the rendered video before it joins the library." };
  }

  const files = await storedFilesOf(sql, session.organization_id, session.id);
  const records = await rightsRecordsOf(sql, session.organization_id, session.brand_id);
  const gate = rightsGate(files, records, todayIso());
  if (!gate.ok) {
    return { ok: false, reason: `No valid rights record covers ${gate.missing.join(", ")}. Add the rights under Content standards, then try again.` };
  }

  return {
    ok: true,
    source: {
      organizationId: session.organization_id,
      brandId: session.brand_id,
      sessionId: session.id,
      runId: input.runId,
      variantId: variant.id,
      variantKey: input.variantKey,
      sessionTitle: session.title ?? "",
      renderedArtifactId: variant.rendered_artifact_id,
      rightsRecordIds: coveringRightsRecordIds(files, records, todayIso()),
    },
  };
}

/**
 * The library creative of one variation, created once. A second call returns the creative the first one made. The asset references the
 * variation's rendered media by its storage key, so the binary is not copied.
 */
export async function linkRepurposedVariantCreative(
  sql: Sql,
  input: RepurposedVariantSource & { createdBy: string },
): Promise<{ creativeId: string; assetId: string; created: boolean }> {
  return withTransaction(sql, async (tx) => {
    const existing = await tx<{ id: string }>`
      select c.id from creative_records c
      where c.organization_id = ${input.organizationId} and c.repurpose_variant_id = ${input.variantId}
      limit 1
    `;
    if (existing[0]) {
      const asset = await tx<{ id: string }>`select id from assets where creative_id = ${existing[0].id} and organization_id = ${input.organizationId} order by version limit 1`;
      return { creativeId: existing[0].id, assetId: asset[0]?.id ?? "", created: false };
    }

    const stored = await readArtifact(tx, { organizationId: input.organizationId, artifactId: input.renderedArtifactId });
    if (!stored.storage) throw new Error("The rendered video is not stored, so it cannot join the library. Nothing was changed.");

    const creativeId = randomUUID();
    const inserted = await tx<{ id: string }>`
      insert into creative_records (
        id, organization_id, brand_id, origin, source_identifier, title, format, platform, status, created_by, repurpose_variant_id
      ) values (
        ${creativeId}, ${input.organizationId}, ${input.brandId}, 'generated', ${`repurpose:${input.variantId}`},
        ${`${input.sessionTitle || "Repurposed video"} (${input.variantKey})`}, 'video', 'meta', 'approved', ${input.createdBy}, ${input.variantId}
      )
      on conflict do nothing
      returning id
    `;
    if (inserted.length === 0) {
      // A concurrent link made the creative first. Its asset is already written, so this call returns that creative.
      const raced = await tx<{ id: string }>`
        select id from creative_records where organization_id = ${input.organizationId} and repurpose_variant_id = ${input.variantId} limit 1
      `;
      const asset = await tx<{ id: string }>`select id from assets where creative_id = ${raced[0]!.id} and organization_id = ${input.organizationId} order by version limit 1`;
      return { creativeId: raced[0]!.id, assetId: asset[0]?.id ?? "", created: false };
    }

    const assetId = randomUUID();
    await tx`
      insert into assets (id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status)
      values (
        ${assetId}, ${input.organizationId}, ${input.brandId}, ${creativeId}, 1, ${stored.storage.key},
        ${stored.envelope.contentHash}, ${stored.storage.mimeType}, 'repurpose', 'stored'
      )
    `;
    return { creativeId, assetId, created: true };
  });
}
