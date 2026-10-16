// The event store (Bible 16.1: written to engine_events, append-only). This file holds the interface and an in-memory store for
// tests. The Postgres store is written by the lead or eng-pipeline on engine_events (migration 0077): an insert with
// `on conflict (organization_id, dedupe_key) do nothing`, the same shape as the engine's own recordEvent in jobs/orchestrator-sql.ts.

import type { EventKind } from "./schema.ts";

/** One row of the stream, as stored. The body is the validated payload of the event. */
export type EventRecord = {
  organizationId: string;
  requestId: string;
  kind: EventKind;
  stage: string;
  subjectId: string;
  /** The job that wrote the event, or "" when no job did (engine_events.job_id is text, not null). */
  jobId: string;
  /** Null for an event that never repeats. A key that is already stored in the workspace is not stored again. */
  dedupeKey: string | null;
  body: unknown;
  at: string;
};

export type AppendOutcome = { created: boolean };

export interface EventStore {
  /** Append one event. A dedupe key already stored in the workspace changes nothing and reports created false. */
  append(record: EventRecord): Promise<AppendOutcome>;
  /** The events of one request, in the order they were stored. */
  list(scope: { organizationId: string; requestId: string }): Promise<EventRecord[]>;
}

/** An in-memory store with the same dedupe rule as the table. Values are copied in and out. */
export function memoryEventStore(): EventStore {
  const rows: EventRecord[] = [];
  const keys = new Set<string>();
  const copy = <T>(value: T): T => structuredClone(value);

  return {
    async append(record) {
      if (record.dedupeKey !== null) {
        const key = `${record.organizationId}\u0000${record.dedupeKey}`;
        if (keys.has(key)) return { created: false };
        keys.add(key);
      }
      rows.push(copy(record));
      return { created: true };
    },

    async list(scope) {
      return rows
        .filter((row) => row.organizationId === scope.organizationId && row.requestId === scope.requestId)
        .map((row) => copy(row));
    },
  };
}
