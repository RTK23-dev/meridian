// Where the E1 run keeps its ledger, its artifacts and its media. Two backends:
// - memory: the dry run by default. Artifacts are built and validated, and nothing is persisted (the report says so).
// - postgres: the engine's own SQL ledger (sqlLedgerStore) and artifact writer (writeArtifact) on a Postgres handle. The
//   live run uses DATABASE_URL through src/lib/db.ts; a dry run with --with-database uses the test helper's PGlite.
// Media goes to an E1MediaStore: the dry run keeps stand-in bytes in memory, and a live run uses Meridian's Drive-backed
// object store (the Postgres storage_objects row is written by the store itself).

import { contentHash, envelopeSchema, newId, type ArtifactEnvelope, type ArtifactType, type ProductionRequest } from "../../src/engine/contracts/index.ts";
import { memoryLedgerStore, type LedgerStore } from "../../src/engine/budget/store.ts";
import { ARTIFACT_BODY_SCHEMAS } from "../../src/engine/jobs/artifact-store.ts";
import type { Sql } from "../../src/lib/meridian/learning/store.ts";
import { E1_FORMAT_ID } from "./e1-build.ts";

/** Reads and writes media by store:// URI. A missing object reads as null, never as empty bytes. */
export type E1MediaStore = {
  read(uri: string): Promise<Uint8Array | null>;
  write(input: { key: string; mimeType: string; bytes: Uint8Array }): Promise<string>;
};

/** The object store Meridian's Drive store satisfies (src/lib/meridian/storage/object-store.ts). */
export type ObjectStorePort = {
  put(input: { organizationId: string; brandId: string; key: string; mimeType: string; bytes: Uint8Array }): Promise<{ key: string }>;
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array } | null>;
};

export const STORE_URI_PREFIX = "store://";

/** The object key of a store:// URI. Keys with a leading slash, a backslash or ".." are refused. */
export function storeKeyOf(uri: string): string {
  if (!uri.startsWith(STORE_URI_PREFIX)) throw new Error(`media URI ${uri} must start with ${STORE_URI_PREFIX}`);
  const key = uri.slice(STORE_URI_PREFIX.length);
  if (key.length === 0 || key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) {
    throw new Error(`media URI ${uri} names no allowed object key`);
  }
  return key;
}

export function memoryMediaStore(seed: Record<string, Uint8Array>): E1MediaStore {
  const objects = new Map<string, Uint8Array>(Object.entries(seed));
  return {
    async read(uri) {
      const found = objects.get(uri);
      return found ? new Uint8Array(found) : null;
    },
    async write({ key, bytes }) {
      const uri = `${STORE_URI_PREFIX}${key}`;
      objects.set(uri, new Uint8Array(bytes));
      return uri;
    },
  };
}

/** Meridian's object store, scoped to one workspace and brand. */
export function objectStoreMedia(store: ObjectStorePort, organizationId: string, brandId: string): E1MediaStore {
  return {
    async read(uri) {
      const found = await store.get(organizationId, brandId, storeKeyOf(uri));
      return found ? found.bytes : null;
    },
    async write({ key, mimeType, bytes }) {
      const stored = await store.put({ organizationId, brandId, key, mimeType, bytes });
      return `${STORE_URI_PREFIX}${stored.key}`;
    },
  };
}

export type ArtifactWrite = {
  organizationId: string;
  requestId: string;
  stage: string;
  type: ArtifactType;
  body: unknown;
  parentIds: string[];
  createdAt: string;
};

export type E1Backend = {
  /** Named in the report: "memory", or "postgres" with where the handle came from. */
  label: string;
  ledger: LedgerStore;
  media: E1MediaStore;
  /** Records the request, then its production request artifact. The request row must exist before any other artifact. */
  beginRequest(input: { organizationId: string; requestId: string; body: ProductionRequest; createdAt: string; brandId: string }): Promise<ArtifactEnvelope<unknown>>;
  writeArtifact(input: ArtifactWrite): Promise<ArtifactEnvelope<unknown>>;
};

const ENVELOPE_SCHEMA_BY_TYPE: Partial<Record<ArtifactType, string>> = {
  take_verdict: "meridian.take_verdict/v1",
  gate_result: "meridian.gate_result/v1",
  rendered_video: "meridian.rendered_video/v1",
};

/** An envelope validated against its body contract, as writeArtifact builds it (used when nothing is persisted). */
function memoryEnvelope(input: ArtifactWrite): ArtifactEnvelope<unknown> {
  const bodySchema = ARTIFACT_BODY_SCHEMAS[input.type];
  const parsed: unknown = bodySchema.parse(input.body);
  const literal = typeof parsed === "object" && parsed !== null ? (parsed as { schema?: unknown }).schema : undefined;
  const schema = typeof literal === "string" ? literal : ENVELOPE_SCHEMA_BY_TYPE[input.type];
  if (schema === undefined) throw new Error(`${input.type} has no schema name`);
  const envelope: ArtifactEnvelope<unknown> = {
    artifactId: newId("art_"),
    type: input.type,
    schema,
    workspaceId: input.organizationId,
    requestId: input.requestId,
    parentIds: input.parentIds,
    contentHash: contentHash(parsed),
    createdAt: input.createdAt,
    body: parsed,
  };
  envelopeSchema(bodySchema).parse(envelope);
  return envelope;
}

/** Nothing is persisted. The artifacts are built and validated, so their ids and hashes are real but not stored. */
export function memoryBackend(media: E1MediaStore): E1Backend {
  return {
    label: "memory",
    ledger: memoryLedgerStore(),
    media,
    async beginRequest(input) {
      return memoryEnvelope({
        organizationId: input.organizationId,
        requestId: input.requestId,
        stage: "intake",
        type: "production_request",
        body: input.body,
        parentIds: [],
        createdAt: input.createdAt,
      });
    },
    async writeArtifact(input) {
      return memoryEnvelope(input);
    },
  };
}

/**
 * The Postgres backend: the engine's SQL ledger and its artifact writer. The request row is inserted first (writeArtifact
 * refuses an artifact for a request that does not exist), then the production request artifact is written, and then the row's
 * orchestrator state is set to the state the start event produces, pointing at that artifact. No job is queued: the
 * acceptance run is not a request the worker processes.
 */
export async function sqlBackend(options: { sql: Sql; label: string; media: E1MediaStore; organizationId: string }): Promise<E1Backend> {
  const { sql, label, media, organizationId } = options;
  const { sqlLedgerStore } = await import("../../src/engine/jobs/sql-ledger-store.ts");
  const { writeArtifact } = await import("../../src/engine/jobs/artifact-store.ts");
  const { advance } = await import("../../src/engine/jobs/orchestrator.ts");
  return {
    label,
    media,
    ledger: sqlLedgerStore(sql, organizationId),
    async beginRequest(input) {
      await sql`
        insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, current_stage, state)
        values (${input.requestId}, ${input.organizationId}, ${input.brandId}, ${E1_FORMAT_ID}, 'normal', 'running', '', '')
      `;
      const artifact = await writeArtifact(sql, {
        organizationId: input.organizationId,
        requestId: input.requestId,
        stage: "intake",
        type: "production_request",
        body: input.body,
        parentIds: [],
        createdAt: input.createdAt,
      });
      const started = advance(null, {
        type: "start",
        organizationId: input.organizationId,
        requestId: input.requestId,
        priority: "normal",
        cachedDna: false,
        variantCount: 0,
        requestArtifactId: artifact.artifactId,
      });
      await sql`
        update engine_requests set state = ${JSON.stringify(started.state)}
        where id = ${input.requestId} and organization_id = ${input.organizationId}
      `;
      return artifact;
    },
    async writeArtifact(input) {
      return writeArtifact(sql, input);
    },
  };
}
