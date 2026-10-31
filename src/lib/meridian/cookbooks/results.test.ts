// Results by cookbook and setting (K28): a missing measure is unknown, never 0; a setting groups the runs that had it; one run is marked n=1.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resultsTable, type RecordedRun } from "./results.ts";

const RUNS: RecordedRun[] = [
  { cookbookId: "ck_a", version: 1, values: { pace: 1 }, how: "confirmed", measures: { hardCuts: 9, meanMotion: 0.02 } },
  { cookbookId: "ck_a", version: 1, values: { pace: 1.2 }, how: "changed", measures: { hardCuts: 7, meanMotion: null } },
  { cookbookId: "ck_a", version: 1, values: { pace: 1.2 }, how: "changed", measures: { hardCuts: 8 } },
  { cookbookId: "ck_a", version: 2, values: { pace: 1 }, how: "auto_accepted", measures: null },
];

test("a missing measure is counted as unknown, and never averaged in as 0", () => {
  const table = resultsTable(RUNS, ["hardCuts", "meanMotion"]);
  const all = table.find((row) => row.cookbookId === "ck_a" && row.version === 1 && row.setting === "all runs");
  assert.equal(all?.runs, 3);
  assert.deepEqual(all?.measures.hardCuts, { mean: 8, measured: 3, unknown: 0 });
  assert.deepEqual(all?.measures.meanMotion, { mean: 0.02, measured: 1, unknown: 2 }, "two runs did not measure it: unknown, so the mean is 0.02, not 0.007");
});

test("a setting groups the runs that had it, and a single run is one run", () => {
  const table = resultsTable(RUNS, ["hardCuts"]);
  const paceOne = table.find((row) => row.version === 1 && row.setting === "pace=1");
  assert.equal(paceOne?.runs, 1);
  const paceFast = table.find((row) => row.version === 1 && row.setting === "pace=1.2");
  assert.equal(paceFast?.runs, 2);
  assert.equal(paceFast?.measures.hardCuts?.mean, 7.5);
});

test("versions are kept apart, and an all-unknown measure has no mean", () => {
  const table = resultsTable(RUNS, ["hardCuts"]);
  const v2 = table.find((row) => row.version === 2 && row.setting === "all runs");
  assert.deepEqual(v2?.measures.hardCuts, { mean: null, measured: 0, unknown: 1 });
});

test("the table does not depend on the order the runs were recorded in", () => {
  const once = JSON.stringify(resultsTable(RUNS, ["hardCuts"]));
  const reversed = JSON.stringify(resultsTable([...RUNS].reverse(), ["hardCuts"]));
  assert.equal(reversed, once);
});
