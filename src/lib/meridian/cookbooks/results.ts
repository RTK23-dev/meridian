// Results by cookbook, version and setting (round 3, K28, decision D6). Pure: it takes recorded runs (their cookbook, version, values and the
// measures of their published output) and gives one row per cookbook, version and setting, for the research agents. A measure that is missing
// for a run is unknown: it is counted as missing, never averaged in as 0. A row with one run says n=1, so no one reads a trend into it.
//
// These are measurements and counts, not scores. A score stays a score until a calibration report says otherwise (AGENTS rule 9), and this file
// makes none.

import type { Measures } from "./checks.ts";

export type RecordedRun = {
  cookbookId: string;
  version: number;
  values: Record<string, string | number | boolean>;
  /** How the run's cookbook was chosen (K11). */
  how: "confirmed" | "changed" | "auto_accepted" | "picked";
  /** The measures of the published output, when there is one. */
  measures: Measures | null;
};

export type ResultRow = {
  cookbookId: string;
  version: number;
  /** One setting and its value, for example `pace=1.2`. The row covers every run that had that setting. */
  setting: string;
  runs: number;
  /** Per measure: the mean over the runs that measured it, and how many runs did not. */
  measures: Record<string, { mean: number | null; measured: number; unknown: number }>;
};

/** One row per (cookbook, version, setting), plus one "all runs" row per cookbook and version. */
export function resultsTable(runs: readonly RecordedRun[], measureNames: readonly string[]): ResultRow[] {
  const groups = new Map<string, { cookbookId: string; version: number; setting: string; runs: RecordedRun[] }>();
  const add = (cookbookId: string, version: number, setting: string, run: RecordedRun) => {
    const key = `${cookbookId}@${version}|${setting}`;
    const group = groups.get(key) ?? { cookbookId, version, setting, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  };
  for (const run of runs) {
    add(run.cookbookId, run.version, "all runs", run);
    for (const [name, value] of Object.entries(run.values).sort(([a], [b]) => a.localeCompare(b))) {
      add(run.cookbookId, run.version, `${name}=${String(value)}`, run);
    }
  }
  return [...groups.values()]
    .sort((a, b) => `${a.cookbookId}@${a.version}`.localeCompare(`${b.cookbookId}@${b.version}`) || a.setting.localeCompare(b.setting))
    .map((group) => ({
      cookbookId: group.cookbookId,
      version: group.version,
      setting: group.setting,
      runs: group.runs.length,
      measures: Object.fromEntries(measureNames.map((name) => [name, meanOf(group.runs, name)])),
    }));
}

function meanOf(runs: readonly RecordedRun[], name: string): { mean: number | null; measured: number; unknown: number } {
  const values: number[] = [];
  let unknown = 0;
  for (const run of runs) {
    const raw = run.measures?.[name];
    if (typeof raw === "number" && Number.isFinite(raw)) values.push(raw);
    else unknown += 1;
  }
  const mean = values.length === 0 ? null : Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1000) / 1000;
  return { mean, measured: values.length, unknown };
}

export type ResultsExport = {
  kind: "meridian.cookbook-results";
  generatedAt: string;
  runs: number;
  /** Records that could not be read. They are counted here, so the export does not look like a complete set when it is not. */
  unreadableRuns: number;
  /** False when no run has a measure of its published output, which is so until a store keeps those measures. */
  measuresRecorded: boolean;
  note: string;
  rows: ResultRow[];
};

/** The export for the research agents (K28): the table, with the counts that say how complete it is. Its time is passed in, so it is deterministic. */
export function resultsExportOf(input: {
  generatedAt: string;
  runs: readonly RecordedRun[];
  unreadable: number;
  measureNames: readonly string[];
}): ResultsExport {
  const measuresRecorded = input.runs.some((run) => run.measures !== null);
  return {
    kind: "meridian.cookbook-results",
    generatedAt: input.generatedAt,
    runs: input.runs.length,
    unreadableRuns: input.unreadable,
    measuresRecorded,
    note: measuresRecorded
      ? "A measure is the mean over the runs that measured it. A missing measure is counted as unknown, not as 0. These are counts and means, not scores."
      : "No run has a measure of its published output yet, so every measure is unknown. These are counts, not scores.",
    rows: resultsTable(input.runs, input.measureNames),
  };
}
