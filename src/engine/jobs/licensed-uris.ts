// The store uris of a request's media that carry a licence record for commercial social use (Bible 12.3), read for the pre-render rights
// check. A take or a voice track is licensed when:
// - its provider is "reviewer": the reviewer supplied it and stands behind its rights (D12, reviewer-clips.ts), or
// - its provider is named in the deployment's list of providers whose outputs the owner licenses for commercial social use.
// The list is a deployment setting with no default. Unset, only reviewer clips pass, and every generated or stock take fails the rights
// check: missing evidence is a review, never a pass (AGENTS rule 8). Read only.
//
// Not covered here: the product's own images and the reference video's uris have no licence record source yet, so a render that uses
// them fails the rights check until one is built.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { takeSchema } from "../contracts/take.ts";
import { voiceTrackSchema } from "../contracts/voice.ts";
import { readArtifact } from "./artifact-store.ts";
import { REVIEWER_PROVIDER } from "./reviewer-clips.ts";
import { readEngineRequest } from "./orchestrator-sql.ts";

/** The provider names in the deployment's list: comma-separated, trimmed, lower-cased. An unset or empty list names none. */
export function licensedProvidersOf(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}

/** Whether one provider's output is licensed: the reviewer's own clip, or a provider the deployment's list names. */
export function isLicensedProvider(provider: string, licensed: ReadonlySet<string>): boolean {
  return provider === REVIEWER_PROVIDER || licensed.has(provider.toLowerCase());
}

/** The store uris of the request's takes and voice track that are licensed. Empty when the request has no state yet. */
export async function licensedUrisOf(
  sql: Sql,
  input: { organizationId: string; requestId: string; licensedProviders: ReadonlySet<string> },
): Promise<Set<string>> {
  const read = await readEngineRequest(sql, input.organizationId, input.requestId);
  const uris = new Set<string>();
  if (!read) return uris;
  for (const [slot, artifactId] of Object.entries(read.state.artifacts)) {
    const isTake = slot.startsWith("take:");
    const isVoice = slot === "voice";
    if (!isTake && !isVoice) continue;
    const body = (await readArtifact(sql, { organizationId: input.organizationId, artifactId })).envelope.body;
    if (isTake) {
      const take = takeSchema.safeParse(body);
      if (take.success && isLicensedProvider(take.data.provider, input.licensedProviders)) uris.add(take.data.uri);
    } else {
      const track = voiceTrackSchema.safeParse(body);
      if (track.success && isLicensedProvider(track.data.provider, input.licensedProviders)) uris.add(track.data.uri);
    }
  }
  return uris;
}
