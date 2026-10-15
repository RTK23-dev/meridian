// The Postgres event store (Video Engine Bible 16.1, E5). It implements the EventStore interface of events/store.ts on the
// engine_events table (migration 0077): an insert with `on conflict (organization_id, dedupe_key) do nothing`, so a key that is
// stored in the workspace is stored once, whatever job retries. Every row is scoped to its workspace, and the request's foreign key
// refuses a row for a request that is not in the workspace.
//
// list() returns the learning events only (the kinds of events/schema.ts). The orchestrator also writes its own log rows
// (stage.succeeded, stage.dead, resume, start, human_choice, gold_label) to the same table; they are not learning events and are
// not returned here, so the type of each row is honest.

import { randomUUID } from "node:crypto";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { EVENT_KINDS, type EventKind } from "../events/schema.ts";
import type { AppendOutcome, EventRecord, EventStore } from "../events/store.ts";

const knownKinds: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

function isEventKind(kind: string): kind is EventKind {
  return knownKinds.has(kind);
}

function bodyOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The EventStore of one database handle. Append is idempotent per workspace dedupe key. */
export function sqlEventStore(sql: Sql): EventStore {
  return {
    async append(record: EventRecord): Promise<AppendOutcome> {
      const rows = await sql<{ id: string }>`
        insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body, created_at)
        values (${randomUUID()}, ${record.organizationId}, ${record.requestId}, ${record.kind}, ${record.stage}, ${record.subjectId},
          ${record.jobId}, ${record.dedupeKey}, ${JSON.stringify(record.body ?? {})}, ${record.at})
        on conflict (organization_id, dedupe_key) do nothing
        returning id
      `;
      return { created: rows.length > 0 };
    },

    async list(scope: { organizationId: string; requestId: string }): Promise<EventRecord[]> {
      const rows = await sql<{ kind: string; stage: string; subject_id: string; job_id: string; dedupe_key: string | null; body: string; created_at: string }>`
        select kind, stage, subject_id, job_id, dedupe_key, body, created_at from engine_events
        where organization_id = ${scope.organizationId} and request_id = ${scope.requestId}
        order by created_at asc, id asc
      `;
      const records: EventRecord[] = [];
      for (const row of rows) {
        if (!isEventKind(row.kind)) continue;
        records.push({
          organizationId: scope.organizationId,
          requestId: scope.requestId,
          kind: row.kind,
          stage: row.stage,
          subjectId: row.subject_id,
          jobId: row.job_id,
          dedupeKey: row.dedupe_key,
          body: bodyOf(row.body),
          at: new Date(row.created_at).toISOString(),
        });
      }
      return records;
    },
  };
}
