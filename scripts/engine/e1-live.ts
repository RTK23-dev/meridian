// The live side of the E1 run: a preflight that fails closed before any spend, and the wiring of Meridian's own connectors
// (the gateway's credential source, DATABASE_URL through src/lib/db.ts, and the Drive-backed object store). The engine never
// reads a key: the gateway asks Meridian's credential resolver at the moment of each call (gateway/meridian.ts).

import { createGateway, fetchHttpTransport, meridianCredentialSource, type Gateway } from "../../src/engine/gateway/index.ts";
import { objectStoreMedia, sqlBackend, type E1Backend, type ObjectStorePort } from "./e1-backend.ts";

export type MissingItem = "heygen" | "media_functions" | "platform_size_limit" | "database" | "storage";

export type Missing = { item: MissingItem; reason: string };

export type LiveSetup = { ok: true; gateway: Gateway; backend: E1Backend } | { ok: false; missing: Missing[] };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks every connection the live run needs and reports each one that is missing. Nothing is spent here: the checks read
 * Meridian's connection state and send no paid request. The media functions' base URL is a deployment setting passed in.
 */
export async function liveSetup(input: {
  organizationId: string;
  brandId: string;
  mediaFunctionsBaseUrl: string | null;
  platformMaxBytes: number | null;
  /** --database: the ledger and artifacts go to the Postgres that DATABASE_URL names (read by src/lib/db.ts, only when asked). */
  database: boolean;
}): Promise<LiveSetup> {
  const gateway = createGateway({
    transport: fetchHttpTransport,
    credentials: meridianCredentialSource(),
    ...(input.mediaFunctionsBaseUrl === null ? {} : { providers: { media_functions: { baseUrl: input.mediaFunctionsBaseUrl } } }),
  });
  const missing: Missing[] = [];

  const heygen = await gateway.connection("heygen", input.organizationId);
  if (!heygen.connected) missing.push({ item: "heygen", reason: heygen.reason ?? "heygen is not connected" });

  const media = await gateway.connection("media_functions", input.organizationId);
  if (!media.connected) missing.push({ item: "media_functions", reason: media.reason ?? "media_functions is not connected" });

  if (input.platformMaxBytes === null) {
    missing.push({
      item: "platform_size_limit",
      reason:
        "no platform file-size limit was given (--platform-max-bytes). thresholds.render.platformMaxBytes is null, and the integrity gate fails closed without it",
    });
  }

  // src/lib/db.ts is imported only when asked. Importing it without DATABASE_URL starts an embedded PGlite, which is not a
  // live ledger, so an unasked import would both slow the check and blur what it proved.
  let database: { sql: Parameters<typeof sqlBackend>[0]["sql"] } | null = null;
  if (!input.database) {
    missing.push({
      item: "database",
      reason: "--database was not given. A live run keeps its ledger and artifacts in the Postgres that DATABASE_URL names",
    });
  } else {
    try {
      const db = await import("../../src/lib/db.ts");
      if (db.dbSource !== "neon") {
        missing.push({ item: "database", reason: "DATABASE_URL is not set, so the run would have no Postgres ledger" });
      } else {
        database = { sql: await db.getSql() };
      }
    } catch (error) {
      missing.push({ item: "database", reason: `DATABASE_URL could not be used: ${describe(error)}` });
    }
  }

  let store: ObjectStorePort | null = null;
  if (database !== null) {
    const drive = await import("../../src/lib/meridian/storage/drive.ts");
    const health = await drive.googleDriveClient.health(input.organizationId);
    if (health.status !== "HEALTHY") {
      missing.push({ item: "storage", reason: `Google Drive is ${health.status} for this workspace: ${health.detail}` });
    } else {
      const objects = await import("../../src/lib/meridian/storage/object-store.ts");
      store = objects.createGoogleDriveObjectStore(drive.googleDriveClient, {
        metadataRepo: objects.createSqlStorageMetadataRepository(database.sql),
      });
    }
  }

  if (missing.length > 0 || database === null || store === null) {
    return { ok: false, missing };
  }
  const backend = await sqlBackend({
    sql: database.sql,
    label: "postgres (DATABASE_URL)",
    media: objectStoreMedia(store, input.organizationId, input.brandId),
    organizationId: input.organizationId,
  });
  return { ok: true, gateway, backend };
}
