// Artifacts (Video Engine Bible 5.2): each stage writes one validated ArtifactEnvelope. JSON bodies are stored in
// engine_artifacts. Media bytes go to Meridian's object store under engine/{workspaceId}/{requestId}/{stage}/{artifactId}.{ext}.
// Nothing is updated: a redo writes a new artifact that names the old one as a parent. S3 is retired (NORTH_STAR decision 2),
// so the only storage path is the object-store port below, which Meridian's Drive-backed store satisfies.

import { z } from "zod";
import {
  assetSpecSchema,
  budgetReservationSchema,
  canonicalJson,
  compositionSchema,
  contentHash,
  EngineError,
  edlSchema,
  envelopeSchema,
  gateResultSchema,
  idSchema,
  manifestSchema,
  newId,
  productionRequestSchema,
  renderedVideoSchema,
  reviewResultSchema,
  scenePlanSchema,
  takeSchema,
  takeVerdictSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type ArtifactEnvelope,
  type ArtifactType,
} from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { createGoogleDriveObjectStore } from "../../lib/meridian/storage/object-store.ts";

/** The validated body schema of each artifact type (Bible 4, with the v1 additions). */
export const ARTIFACT_BODY_SCHEMAS: Record<ArtifactType, z.ZodType> = {
  production_request: productionRequestSchema,
  validated_request: validatedRequestSchema,
  video_dna: videoDnaSchema,
  voice_track: voiceTrackSchema,
  scene_plan: scenePlanSchema,
  budget_reservation: budgetReservationSchema,
  asset_spec: assetSpecSchema,
  take: takeSchema,
  take_verdict: takeVerdictSchema,
  edl: edlSchema,
  composition: compositionSchema,
  rendered_video: renderedVideoSchema,
  gate_result: gateResultSchema,
  review_result: reviewResultSchema,
  manifest: manifestSchema,
};

/** The envelope's schema name for bodies that carry no schema literal of their own. */
const ENVELOPE_SCHEMA_NAMES: Partial<Record<ArtifactType, string>> = {
  take_verdict: "meridian.take_verdict/v1",
  gate_result: "meridian.gate_result/v1",
  rendered_video: "meridian.rendered_video/v1",
};

export const MEDIA_MIME_TYPES = {
  mp4: "video/mp4",
  wav: "audio/wav",
  png: "image/png",
} as const;
export type MediaExtension = keyof typeof MEDIA_MIME_TYPES;

/** The object-store port. Meridian's Google Drive store has this shape (checked below), and tests use a fake. */
export type MediaStorePort = {
  put(input: { organizationId: string; brandId: string; key: string; mimeType: string; bytes: Uint8Array }): Promise<{ key: string; checksum: string; size: number }>;
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
};

// Compile-time check: Meridian's object store satisfies the port the artifact store uses.
type DriveObjectStore = ReturnType<typeof createGoogleDriveObjectStore>;
export const mediaPortMatchesDriveStore: DriveObjectStore extends MediaStorePort ? true : never = true;

const SAFE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The object key of a media artifact (Bible 5.2). A part may not contain a slash or "..". */
export function mediaKey(input: { workspaceId: string; requestId: string; stage: string; artifactId: string; extension: MediaExtension }): string {
  const parts = [input.workspaceId, input.requestId, input.stage, input.artifactId];
  for (const part of parts) {
    if (!SAFE_PART.test(part) || part.includes("..")) {
      throw new EngineError("invalid_input", `object key part ${JSON.stringify(part)} is not allowed`);
    }
  }
  return `engine/${input.workspaceId}/${input.requestId}/${input.stage}/${input.artifactId}.${input.extension}`;
}

export type MediaInput = { store: MediaStorePort; brandId: string; extension: MediaExtension; bytes: Uint8Array };

export type WriteArtifactInput = {
  organizationId: string;
  requestId: string;
  stage: string;
  type: ArtifactType;
  body: unknown;
  parentIds?: string[];
  createdAt: string;
  media?: MediaInput;
  /**
   * The id to store the artifact under. Absent, a new one is made. A stage that names its media in the body (a take's uri is its
   * object key) fixes the id first, so the body and the storage key agree.
   */
  artifactId?: string;
};

/** A stored artifact as read back: the envelope, and where its media bytes are when it has any. */
export type StoredArtifact = {
  envelope: ArtifactEnvelope<unknown>;
  storage: { key: string; mimeType: string; bytes: number } | null;
};

function refuse(message: string): never {
  throw new EngineError("invalid_input", message);
}

function schemaNameFor(type: ArtifactType, parsed: unknown): string {
  const literal = typeof parsed === "object" && parsed !== null ? (parsed as { schema?: unknown }).schema : undefined;
  if (typeof literal === "string") return literal;
  const name = ENVELOPE_SCHEMA_NAMES[type];
  if (!name) throw new EngineError("internal", `${type} has no schema name`);
  return name;
}

/**
 * Validates and stores one artifact. The body is checked with its contract. Media bytes are stored first, so a failure after
 * that leaves an unreferenced object, never a row that points at nothing. Refuses a request that does not exist in the workspace.
 */
export async function writeArtifact(sql: Sql, input: WriteArtifactInput): Promise<ArtifactEnvelope<unknown>> {
  const bodySchema = ARTIFACT_BODY_SCHEMAS[input.type];
  if (!bodySchema) refuse(`${String(input.type)} is not an artifact type`);
  const parsedBody = bodySchema.safeParse(input.body);
  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    refuse(`${input.type} body is not valid: ${issue ? issue.path.join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim());
  }
  const parentIds = input.parentIds ?? [];
  for (const parent of parentIds) {
    if (!idSchema("art_").safeParse(parent).success) refuse(`parent ${parent} is not an artifact id`);
  }

  const owner = await sql<{ id: string }>`
    select id from engine_requests where id = ${input.requestId} and organization_id = ${input.organizationId} limit 1
  `;
  if (!owner[0]) throw new EngineError("not_found", `request ${input.requestId} is not in this workspace`);

  const artifactId = input.artifactId ?? newId("art_");
  if (!idSchema("art_").safeParse(artifactId).success) refuse(`${artifactId} is not an artifact id`);
  const data: unknown = parsedBody.data;
  const schema = schemaNameFor(input.type, data);
  let storageKey: string | null = null;
  let storageMime: string | null = null;
  let storageBytes: number | null = null;
  let hash: string;
  let bodyText: string;

  if (input.media) {
    if (input.media.bytes.byteLength === 0) refuse("media bytes are empty");
    storageKey = mediaKey({
      workspaceId: input.organizationId,
      requestId: input.requestId,
      stage: input.stage,
      artifactId,
      extension: input.media.extension,
    });
    storageMime = MEDIA_MIME_TYPES[input.media.extension];
    await input.media.store.put({
      organizationId: input.organizationId,
      brandId: input.media.brandId,
      key: storageKey,
      mimeType: storageMime,
      bytes: input.media.bytes,
    });
    hash = contentHash(input.media.bytes);
    storageBytes = input.media.bytes.byteLength;
    bodyText = canonicalJson(data);
  } else {
    hash = contentHash(data);
    bodyText = canonicalJson(data);
  }

  const envelope: ArtifactEnvelope<unknown> = {
    artifactId,
    type: input.type,
    schema,
    workspaceId: input.organizationId,
    requestId: input.requestId,
    parentIds,
    contentHash: hash,
    createdAt: input.createdAt,
    body: data,
  };
  envelopeSchema(bodySchema).parse(envelope);

  await sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body,
      storage_key, storage_mime, storage_bytes, created_at)
    values (${artifactId}, ${input.organizationId}, ${input.requestId}, ${input.type}, ${schema}, ${input.stage},
      ${JSON.stringify(parentIds)}, ${hash}, ${bodyText}, ${storageKey}, ${storageMime}, ${storageBytes}, ${input.createdAt})
  `;
  return envelope;
}

/**
 * Reads one artifact in its workspace. The body is validated again on the way out, and a JSON body's hash is recomputed. A
 * stored row that no longer matches its contract or its hash is an internal error, never returned as good data.
 */
export async function readArtifact(sql: Sql, input: { organizationId: string; artifactId: string }): Promise<StoredArtifact> {
  const rows = await sql<{
    id: string;
    request_id: string;
    type: string;
    schema: string;
    parent_ids: string;
    content_hash: string;
    body: string;
    storage_key: string | null;
    storage_mime: string | null;
    storage_bytes: number | null;
    created_at: unknown;
  }>`
    select id, request_id, type, schema, parent_ids, content_hash, body, storage_key, storage_mime, storage_bytes, created_at
    from engine_artifacts where id = ${input.artifactId} and organization_id = ${input.organizationId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new EngineError("not_found", `artifact ${input.artifactId} is not in this workspace`);
  const type = row.type as ArtifactType;
  const bodySchema = ARTIFACT_BODY_SCHEMAS[type];
  if (!bodySchema) throw new EngineError("internal", `artifact ${row.id} has an unknown type ${row.type}`);

  let raw: unknown;
  try {
    raw = JSON.parse(row.body);
  } catch (error) {
    throw new EngineError("internal", `artifact ${row.id} holds a body that is not JSON`, { cause: error });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new EngineError("internal", `artifact ${row.id} no longer matches its ${type} contract`);
  const body: unknown = parsed.data;
  if (row.storage_key === null && contentHash(body) !== row.content_hash) {
    throw new EngineError("internal", `artifact ${row.id} does not match its stored content hash`);
  }

  const envelope: ArtifactEnvelope<unknown> = {
    artifactId: row.id,
    type,
    schema: row.schema,
    workspaceId: input.organizationId,
    requestId: row.request_id,
    parentIds: JSON.parse(row.parent_ids) as string[],
    contentHash: row.content_hash,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    body,
  };
  envelopeSchema(bodySchema).parse(envelope);
  return {
    envelope,
    storage:
      row.storage_key === null || row.storage_mime === null || row.storage_bytes === null
        ? null
        : { key: row.storage_key, mimeType: row.storage_mime, bytes: row.storage_bytes },
  };
}

/** The media bytes of an artifact. They must match the artifact's hash and size, or the read fails. */
export async function readMediaBytes(store: MediaStorePort, input: { organizationId: string; brandId: string; stored: StoredArtifact }): Promise<Uint8Array> {
  const storage = input.stored.storage;
  if (!storage) throw new EngineError("invalid_input", `artifact ${input.stored.envelope.artifactId} has no media`);
  const object = await store.get(input.organizationId, input.brandId, storage.key);
  if (!object) throw new EngineError("not_found", `the media of ${input.stored.envelope.artifactId} is missing from the object store`);
  if (object.bytes.byteLength !== storage.bytes || contentHash(object.bytes) !== input.stored.envelope.contentHash) {
    throw new EngineError("internal", `the media of ${input.stored.envelope.artifactId} does not match its stored hash and size`);
  }
  return object.bytes;
}

/**
 * Reads exactly the artifacts a job names as inputs (Bible 5.1: the job must not read anything else). Each one must belong to
 * the request the job is for.
 */
export async function readJobInputs(sql: Sql, input: { organizationId: string; requestId: string; inputArtifactIds: string[] }): Promise<StoredArtifact[]> {
  const stored: StoredArtifact[] = [];
  for (const artifactId of input.inputArtifactIds) {
    const artifact = await readArtifact(sql, { organizationId: input.organizationId, artifactId });
    if (artifact.envelope.requestId !== input.requestId) {
      throw new EngineError("invalid_input", `artifact ${artifactId} belongs to another request`);
    }
    stored.push(artifact);
  }
  return stored;
}
