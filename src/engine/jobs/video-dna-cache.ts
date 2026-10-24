// The production VideoDNA lookup: intake's `lookupDna` port (Bible 6.1 step 5). Intake must know whether a VideoDNA for the request's reference
// is already stored before it can pass the request gate. Without this port the gate reads "the VideoDNA lookup has not run" and every
// production request fails at intake, so no request could go past its first stage (direct-creation trace, 2026-10-24).

import { videoDnaSchema } from "../contracts/analysis.ts";
import { EngineError } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

/** The part of a request the lookup reads: its workspace and its format id (the reference video's identity: `ref_<sha256>`). */
export type VideoDnaScope = { organizationId: string; request: { format: { formatId: string } } };

/**
 * The id of the newest stored VideoDNA for the request's format, or null when none is stored (a miss: analysis runs). A stored row that does
 * not match its contract is refused, never read as a hit or a miss, because a bad cache entry must not pass either way.
 */
export function videoDnaLookupOf(sql: Sql): (scope: VideoDnaScope) => Promise<string | null> {
  return async (scope) => {
    const rows = await sql<{ body: string }>`
      select body from engine_artifacts
      where organization_id = ${scope.organizationId} and type = 'video_dna' and schema = 'meridian.video_dna/v1'
        and body::jsonb ->> 'formatId' = ${scope.request.format.formatId}
      order by created_at desc, id desc
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const parsed = videoDnaSchema.safeParse(JSON.parse(row.body));
    if (!parsed.success) {
      throw new EngineError("internal", "a stored VideoDNA does not match its contract, so the lookup is refused and nothing was read from it");
    }
    return parsed.data.videoDnaId;
  };
}
