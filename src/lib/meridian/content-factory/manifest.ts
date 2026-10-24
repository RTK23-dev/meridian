import { engineRequestStatus } from "../../../engine/api/index.ts";
import type { Sql } from "../learning/store.ts";

/**
 * The delivered manifest of a session's video, or null when the video is not delivered (or has no request). Each delivery names its own
 * manifest, and a remake or a new clip is delivered again under a new one. An approval or a score is made on this id, so it cannot stand
 * over content that has changed since.
 */
export async function deliveredManifestOf(sql: Sql, organizationId: string, requestId: string | null): Promise<string | null> {
  if (requestId === null) return null;
  const status = await engineRequestStatus(sql, organizationId, requestId);
  return status?.status === "delivered" ? status.manifestId : null;
}
