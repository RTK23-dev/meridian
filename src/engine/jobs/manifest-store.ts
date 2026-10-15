// The engine_manifests table (Video Engine Bible 5.4, 6.14). The deliver stage writes each delivered video's manifest as an immutable
// artifact (engine_artifacts, type manifest) and also as a row here, so a manifest can be read by its request and workspace without
// reading the artifact table. The row's id is the artifact's id, so both rows name the same manifest.
//
// Writes are idempotent: a second write of the same id with the same body changes nothing. A second write with a different body is
// refused (a manifest is never overwritten), which is the same rule the artifact write follows (deliver/write-once.ts).

import { EngineError, contentHash } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

export type ManifestRowInput = {
  organizationId: string;
  requestId: string;
  /** The artifact id of the manifest (engine_artifacts.id). It is also the row id. */
  artifactId: string;
  /** The master's video id is not stored here; the variant's master EDL id is, when the video is a variant. */
  variantOf: string | null;
  body: unknown;
  createdAt: string;
};

export type ManifestRowOutcome = { created: boolean; contentHash: string };

/** Writes the manifest row for one delivered video. Organization-scoped by the request's foreign key and by the explicit column. */
export async function writeManifestRow(sql: Sql, input: ManifestRowInput): Promise<ManifestRowOutcome> {
  const hash = contentHash(input.body);
  const inserted = await sql<{ id: string }>`
    insert into engine_manifests (id, organization_id, request_id, variant_of, body, content_hash, created_at)
    values (${input.artifactId}, ${input.organizationId}, ${input.requestId}, ${input.variantOf}, ${JSON.stringify(input.body)},
      ${hash}, ${input.createdAt})
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length > 0) return { created: true, contentHash: hash };
  const stored = await sql<{ content_hash: string; organization_id: string; request_id: string }>`
    select content_hash, organization_id, request_id from engine_manifests
    where id = ${input.artifactId} limit 1
  `;
  const row = stored[0];
  if (!row || row.organization_id !== input.organizationId || row.request_id !== input.requestId) {
    throw new EngineError("conflict", `manifest ${input.artifactId} belongs to another request or workspace`, { stage: "deliver" });
  }
  if (row.content_hash !== hash) {
    throw new EngineError("conflict", `manifest ${input.artifactId} is already stored with a different body; a manifest is never overwritten`, {
      stage: "deliver",
    });
  }
  return { created: false, contentHash: hash };
}
