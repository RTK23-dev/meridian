// The measures of each request's published output, stored after its post-render review (K28, decision Q41). Engine-owned: one row per request
// and organization (engine_output_measures), read by the cookbook results through the session's request id. A measure is a finite number or
// null (unknown). A value that is not a finite number is stored as null, never as 0.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";

export type OutputMeasuresPort = NonNullable<PostRenderPorts["recordMeasures"]>;

/** Each measure as a finite number or null. */
export function measuresForStorage(measures: Record<string, number | null>): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(measures).map(([name, value]) => [name, typeof value === "number" && Number.isFinite(value) ? value : null]),
  );
}

export function sqlOutputMeasures(sql: Sql): OutputMeasuresPort {
  return async (input) => {
    const measures = JSON.stringify(measuresForStorage(input.measures));
    await sql`
      insert into engine_output_measures (organization_id, request_id, measures, recorded_at)
      values (${input.organizationId}, ${input.requestId}, ${measures}::jsonb, ${input.recordedAt})
      on conflict (organization_id, request_id) do update set measures = excluded.measures, recorded_at = excluded.recorded_at
    `;
  };
}
