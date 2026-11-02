// The cookbook results export (K28, decision Q41): the workspace's recorded runs, with their measures, as the results table's export. The
// function reads the store and builds the export; writing the file to docs/data/ is a separate step that needs the database.

import type { Sql } from "../learning/store.ts";
import { recordedRunsOf } from "./recorded-runs.ts";
import { resultsExportOf, type ResultsExport } from "./results.ts";

/** The measures the engine records for each output (engine_output_measures, written by the post-render review). */
export const OUTPUT_MEASURE_NAMES = ["integrated_lufs", "true_peak_dbtp", "longest_silence_ms", "duration_ms"] as const;

export async function cookbookResultsExport(sql: Sql, input: { organizationId: string; generatedAt: string }): Promise<ResultsExport> {
  const recorded = await recordedRunsOf(sql, { organizationId: input.organizationId });
  return resultsExportOf({
    generatedAt: input.generatedAt,
    runs: recorded.runs,
    unreadable: recorded.unreadable,
    measureNames: OUTPUT_MEASURE_NAMES,
  });
}
