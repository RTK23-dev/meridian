// The recorded runs of a workspace, read from the store for the results table (round 3, K28, decision D6). Each session with a cookbook record
// gives one run: its cookbook, version, values and how it was chosen. The measures of a run's published output are not kept in the store yet
// (nothing writes them), so each run's measures are null: unknown, which the table counts as unknown and never as 0. A record that cannot be
// read is counted as unreadable, not dropped without a trace.

import type { Sql } from "../learning/store.ts";
import type { RecordedRun } from "./results.ts";
import type { StoredSelection } from "./run-record.ts";

export type RecordedRuns = { runs: RecordedRun[]; unreadable: number };

const CHOICES = ["confirmed", "changed", "auto_accepted", "picked"] as const;

function parsed(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The stored choice, when it has the fields a run needs (a cookbook id, a version, values and a known way of choosing), else null. */
function selectionOf(raw: unknown): StoredSelection | null {
  const value = parsed(raw);
  if (typeof value !== "object" || value === null) return null;
  const selection = value as Partial<StoredSelection>;
  if (typeof selection.cookbookId !== "string" || typeof selection.version !== "number") return null;
  if (typeof selection.values !== "object" || selection.values === null) return null;
  if (!CHOICES.some((choice) => choice === selection.how)) return null;
  return selection as StoredSelection;
}

/** The runs of one workspace that carry a cookbook record, in the order the store returns them. */
export async function recordedRunsOf(sql: Sql, input: { organizationId: string }): Promise<RecordedRuns> {
  const rows = await sql<{ cookbook_selection: unknown }>`
    select cookbook_selection from content_factory_sessions
    where organization_id = ${input.organizationId} and cookbook_selection is not null
    order by id
  `;
  const runs: RecordedRun[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const selection = selectionOf(row.cookbook_selection);
    if (selection === null) {
      unreadable += 1;
      continue;
    }
    runs.push({
      cookbookId: selection.cookbookId,
      version: selection.version,
      values: selection.values as RecordedRun["values"],
      how: selection.how,
      measures: null,
    });
  }
  return { runs, unreadable };
}
