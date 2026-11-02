// The recorded runs of a workspace, read from the store for the results table (round 3, K28, decision D6). Each session with a cookbook record
// gives one run: its cookbook, version, values and how it was chosen, and the measures of its published output, when the engine recorded them
// (engine_output_measures, decision Q41). A run without measures has null measures: unknown, which the table counts as unknown and never as 0.
// A record that cannot be read is counted as unreadable, not dropped without a trace.

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

/** The measures the engine recorded for a run's output: each a number or null, and nothing else. Anything else is unknown. */
function measuresOf(raw: unknown): Record<string, number | null> | null {
  const value = parsed(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const measures: Record<string, number | null> = {};
  for (const [name, reading] of Object.entries(value as Record<string, unknown>)) {
    measures[name] = typeof reading === "number" && Number.isFinite(reading) ? reading : null;
  }
  return measures;
}

/** The runs of one workspace that carry a cookbook record, in the order the store returns them. */
export async function recordedRunsOf(sql: Sql, input: { organizationId: string }): Promise<RecordedRuns> {
  const rows = await sql<{ cookbook_selection: unknown; measures: unknown }>`
    select s.cookbook_selection, m.measures
    from content_factory_sessions s
    left join engine_output_measures m
      on m.organization_id = s.organization_id and m.request_id = s.engine_request_id
    where s.organization_id = ${input.organizationId} and s.cookbook_selection is not null
    order by s.id
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
      measures: measuresOf(row.measures),
    });
  }
  return { runs, unreadable };
}
