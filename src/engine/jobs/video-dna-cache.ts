// The VideoDNA cache (Bible 6.1 step 5). A stored analysis of the same reference is reused, so analyze_reference is not run again. The key is
// the reference's identity (the request's formatId, `ref_<sha256 prefix>`) and the analysis version (the stored schema literal): a stored
// analysis of another version is a miss, so a stale analysis is re-run, never read. A hit is copied into the request that uses it, as its own
// video_dna artifact parented on the stored one. A job reads only the artifacts of its own request (artifact-store readJobInputs), and the copy
// keeps the stored content hash and the VideoDNA id, so plan, edit and the gates see the same DNA and its lineage is kept.

import { videoDnaSchema, type VideoDNA } from "../contracts/analysis.ts";
import { EngineError } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact, writeArtifact } from "./artifact-store.ts";
import { stableId } from "./stable-id.ts";

/** The analysis version a cached VideoDNA must carry. A new analysis writes a new schema literal, so an older analysis is never reused. */
export const VIDEO_DNA_ANALYSIS_VERSION = "meridian.video_dna/v1";

/** A stored VideoDNA that may be reused: the artifact that holds it, and its body, read through the contract and the content hash. */
export type CachedVideoDna = { artifactId: string; videoDnaId: string; body: VideoDNA };

/** The part of a request the lookup reads: its workspace and its format id (the reference video's identity: `ref_<sha256>`). */
export type VideoDnaScope = { organizationId: string; request: { format: { formatId: string } } };

/**
 * The newest stored VideoDNA of the current analysis version for a format, or null when none is stored (a miss: analysis runs). A stored row
 * that fails its contract or its content hash is refused (EngineError), never read as a hit or a miss: a bad cache entry must not pass either way.
 */
export async function cachedVideoDnaFor(sql: Sql, input: { organizationId: string; formatId: string }): Promise<CachedVideoDna | null> {
  const rows = await sql<{ id: string }>`
    select id from engine_artifacts
    where organization_id = ${input.organizationId} and type = 'video_dna' and schema = ${VIDEO_DNA_ANALYSIS_VERSION}
      and body::jsonb ->> 'formatId' = ${input.formatId}
    order by created_at desc, id desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const stored = await readArtifact(sql, { organizationId: input.organizationId, artifactId: row.id });
  const body = videoDnaSchema.parse(stored.envelope.body);
  if (body.formatId !== input.formatId) {
    throw new EngineError("internal", "a stored VideoDNA names another format than the one it was found under, so it is refused");
  }
  return { artifactId: stored.envelope.artifactId, videoDnaId: body.videoDnaId, body };
}

/** Intake's lookup port: the cached VideoDNA of the request's format in its workspace, or null for a miss. */
export function videoDnaLookupOf(sql: Sql): (scope: VideoDnaScope) => Promise<CachedVideoDna | null> {
  return (scope) => cachedVideoDnaFor(sql, { organizationId: scope.organizationId, formatId: scope.request.format.formatId });
}

/**
 * Copies a cached VideoDNA into the request that uses it, as that request's video_dna artifact, parented on the stored one. The copy's id is
 * derived from the request and the stored artifact, so an intake retry finds the copy it already wrote and writes nothing twice. Artifacts are
 * immutable (Bible 5.2), so an existing copy under that id has the same content.
 */
export async function reuseCachedVideoDna(
  sql: Sql,
  input: { organizationId: string; requestId: string; cached: CachedVideoDna; createdAt: string },
): Promise<string> {
  const stored = await readArtifact(sql, { organizationId: input.organizationId, artifactId: input.cached.artifactId });
  const artifactId = stableId("art_", `video_dna_reuse|${input.requestId}|${stored.envelope.artifactId}`);
  const existing = await sql<{ id: string }>`
    select id from engine_artifacts where id = ${artifactId} and organization_id = ${input.organizationId} limit 1
  `;
  if (existing[0]) return artifactId;
  await writeArtifact(sql, {
    organizationId: input.organizationId,
    requestId: input.requestId,
    stage: "intake",
    type: "video_dna",
    body: stored.envelope.body,
    parentIds: [stored.envelope.artifactId],
    createdAt: input.createdAt,
    artifactId,
  });
  return artifactId;
}
