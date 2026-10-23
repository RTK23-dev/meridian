// The sampling ports in production (jobs/sampling.ts): the format's sampling state in engine_sampling_state (migration 0114), and each
// sampled video as an open review item of kind 'sample' in engine_review_items. Every write is keyed, so a retried delivery writes each
// item once.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { EMPTY_SAMPLING_STATE, type SamplingState } from "../review/sampling.ts";
import type { SampledVideoItem, SamplingPorts, SampleScope } from "./sampling.ts";

/** The detail of a sample review item: which video, of which format, drawn at which rate. */
export const SAMPLE_REVIEW_SCHEMA = "meridian.sample_review/v1";

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function sqlSamplingPorts(sql: Sql): SamplingPorts {
  return {
    async state(scope: SampleScope): Promise<SamplingState> {
      const rows = await sql<{ consecutive_passes: unknown; threshold_version: string | null; reset_until: unknown }>`
        select consecutive_passes, threshold_version, reset_until from engine_sampling_state
        where organization_id = ${scope.organizationId} and format_key = ${scope.formatKey}
        limit 1
      `;
      const row = rows[0];
      if (!row) return EMPTY_SAMPLING_STATE;
      return {
        consecutivePasses: Number(row.consecutive_passes),
        thresholdVersion: row.threshold_version,
        resetUntil: isoOf(row.reset_until),
      };
    },
    async save(scope: SampleScope, state: SamplingState): Promise<void> {
      await sql`
        insert into engine_sampling_state (organization_id, format_key, consecutive_passes, threshold_version, reset_until, updated_at)
        values (${scope.organizationId}, ${scope.formatKey}, ${state.consecutivePasses}, ${state.thresholdVersion}, ${state.resetUntil}, now())
        on conflict (organization_id, format_key) do update set
          consecutive_passes = excluded.consecutive_passes,
          threshold_version = excluded.threshold_version,
          reset_until = excluded.reset_until,
          updated_at = now()
      `;
    },
    async queue(item: SampledVideoItem): Promise<void> {
      const detail = JSON.stringify({ schema: SAMPLE_REVIEW_SCHEMA, videoId: item.videoId, formatKey: item.formatKey, rate: item.rate, at: item.at });
      await sql`
        insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
        values (${item.itemId}, ${item.organizationId}, ${item.requestId}, 'sample', 'open', ${item.videoId}, ${item.reason}, ${detail})
        on conflict (id) do nothing
      `;
    },
  };
}
