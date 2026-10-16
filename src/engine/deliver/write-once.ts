// Writes an artifact under an id that does not change on a retry (Video Engine Bible 5.1, 5.2). A deliver or variants job that fails
// after it wrote an artifact is run again, and the second run must not write a second copy. The id is stable (stableId), so the second
// run finds the first copy: when its body is the same, it is reused; when it differs, the retry refuses, because two bodies under one
// id would break the immutability of artifacts (Bible 5.2).

import { contentHash, EngineError } from "../contracts/index.ts";
import { readArtifact, writeArtifact, type WriteArtifactInput } from "../jobs/artifact-store.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

export type WriteOnceInput = WriteArtifactInput & { artifactId: string };

export type WriteOnceResult = { artifactId: string; reused: boolean };

export async function writeArtifactOnce(sql: Sql, input: WriteOnceInput): Promise<WriteOnceResult> {
  let existing: Awaited<ReturnType<typeof readArtifact>> | null = null;
  try {
    existing = await readArtifact(sql, { organizationId: input.organizationId, artifactId: input.artifactId });
  } catch (error) {
    if (!(error instanceof EngineError && error.kind === "not_found")) throw error;
  }
  if (existing === null) {
    const written = await writeArtifact(sql, input);
    return { artifactId: written.artifactId, reused: false };
  }
  if (existing.envelope.type !== input.type || existing.envelope.requestId !== input.requestId) {
    throw new EngineError("conflict", `artifact ${input.artifactId} exists for another ${existing.envelope.type} of another request`, {
      stage: input.stage,
    });
  }
  if (existing.envelope.contentHash !== contentHash(input.body)) {
    throw new EngineError("conflict", `artifact ${input.artifactId} exists with a different body; a retry does not overwrite it`, {
      stage: input.stage,
    });
  }
  return { artifactId: input.artifactId, reused: true };
}
