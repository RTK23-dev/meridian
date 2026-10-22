// The store uris of a request's reviewer clips (D12). A reviewer's own clip is licensed by the reviewer's attestation: the reviewer supplied it
// and stands behind its rights for commercial social use. Its take records the provider "reviewer", which is how the licence check finds it.
// Read only.

import { takeSchema } from "../contracts/take.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact } from "./artifact-store.ts";
import { readEngineRequest } from "./orchestrator-sql.ts";

export const REVIEWER_PROVIDER = "reviewer";

export async function reviewerClipUris(sql: Sql, organizationId: string, requestId: string): Promise<string[]> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  if (!read) return [];
  const uris: string[] = [];
  for (const [slot, artifactId] of Object.entries(read.state.artifacts)) {
    if (!slot.startsWith("take:")) continue;
    const parsed = takeSchema.safeParse((await readArtifact(sql, { organizationId, artifactId })).envelope.body);
    if (parsed.success && parsed.data.provider === REVIEWER_PROVIDER) uris.push(parsed.data.uri);
  }
  return uris.sort();
}
