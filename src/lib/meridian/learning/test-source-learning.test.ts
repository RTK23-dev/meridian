import assert from "node:assert/strict";
import test from "node:test";
import { applyLearnedPatterns, type Sql } from "./store.ts";

// Simulated performance (source test:%) must not train production learning. In the testing runtime the loop is simulated
// end to end, so those rows are the learning input there. These tests check the query the learning step sends.

async function observationQuery(testingRuntime: boolean) {
  const saved = process.env.MERIDIAN_TESTING_RUNTIME;
  if (testingRuntime) process.env.MERIDIAN_TESTING_RUNTIME = "true";
  else delete process.env.MERIDIAN_TESTING_RUNTIME;
  const captured: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  }) as unknown as Sql;
  try {
    await applyLearnedPatterns(sql, "org-learning", "brand-learning");
  } finally {
    if (saved === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
    else process.env.MERIDIAN_TESTING_RUNTIME = saved;
  }
  const query = captured.find((entry) => entry.text.includes("from performance_observations"));
  assert.ok(query, "the observation query runs");
  return query;
}

test("outside the testing runtime, the learning query excludes simulated test-source performance", async () => {
  const query = await observationQuery(false);
  assert.ok(query.text.includes("source not like 'test:%'"), "the exclusion is in the query");
  assert.ok(query.values.includes(false), "the testing-runtime flag is false, so the exclusion applies");
});

test("in the testing runtime, the learning query keeps test-source performance, since the loop is simulated there", async () => {
  const query = await observationQuery(true);
  assert.ok(query.values.includes(true), "the testing-runtime flag is true, so test-source rows are included");
});
