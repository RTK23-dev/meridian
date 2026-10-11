import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { createBrief, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { storedProbability } from "./probability.ts";

// The opportunity and learning readers import the server-function layer, which uses the "@/" alias.
enableAppAliases();
const { opportunityView } = await import("../opportunity/actions.ts");
const { learningDecisionView } = await import("../learning/actions.ts");

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

test("a probability that was never stored reads back as null, and a stored zero stays zero", () => {
  assert.equal(storedProbability(null), null);
  assert.equal(storedProbability(undefined), null);
  assert.equal(storedProbability(""), null);
  assert.equal(storedProbability("not a number"), null);
  assert.equal(storedProbability(Number.NaN), null);
  assert.equal(storedProbability(Number.POSITIVE_INFINITY), null);
  assert.equal(storedProbability(0), 0, "a measured zero is still a zero");
  assert.equal(storedProbability("0.25"), 0.25);
});

test("an opportunity with no stored JEV decision shows a null probability, not 0", () => {
  const view = opportunityView({ id: "opp-1", hypothesis_id: "discovered:angle", status: "open" }, "", null);
  assert.equal(view.probability, null);
  assert.equal(view.decision, "");
});

test("a learning decision with no stored probability or confidence reads back as null", () => {
  const view = learningDecisionView({
    id: "dec-1",
    question_id: "q",
    question_version: "1",
    subject_type: "brief",
    decision: "HUMAN_REVIEW",
    probability: null,
    confidence: null,
    reasons: "[]",
    created_at: "2026-10-01",
  });
  assert.equal(view.probability, null);
  assert.equal(view.confidence, null);
});

/**
 * A brief whose engine failed has no answer that carries a probability. Its decision row must store null, not 0, and the
 * learning reader must return null for it.
 */
async function providerFailureStoresUnknownProbability(sql: Sql) {
  const tenant = await studioTenant(sql, `unknown-probability-${Math.random().toString(36).slice(2, 7)}`);
  const made = await createBrief(sql, tenant, {
    engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })),
    selected: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(made.action, "HUMAN_REVIEW");
  const [row] = await sql<{ probability: number | null; confidence: number | null; decision: string }>`
    select probability, confidence, decision from jev_decisions where id = ${made.decisionId}
  `;
  assert.equal(row?.decision, "HUMAN_REVIEW");
  assert.equal(row?.probability, null, "the stored probability is null, not 0");
  assert.equal(row?.confidence, null, "the stored confidence is null, not 0");
  const [stored] = await sql<Record<string, unknown>>`
    select id, question_id, question_version, subject_type, decision, probability, confidence, reasons, created_at
    from jev_decisions where id = ${made.decisionId}
  `;
  const view = learningDecisionView(stored ?? {});
  assert.equal(view.probability, null, "the learning screen reads the unknown probability as null");
  assert.equal(view.confidence, null);
}

test("a brief the engine could not judge stores a null probability on PGlite", async () => {
  await providerFailureStoresUnknownProbability(await getSql());
});

test("a brief the engine could not judge stores a null probability on PostgreSQL", async (t) => {
  if (!PG_TEST_URL) {
    t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL null-probability check was not run");
    return;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: PG_TEST_URL });
  try {
    await providerFailureStoresUnknownProbability(createPoolSql(pool));
  } finally {
    await pool.end();
  }
});
