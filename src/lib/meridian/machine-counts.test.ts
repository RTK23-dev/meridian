import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../db.ts";
import type { Sql } from "./learning/store.ts";
import { loadMachineCounts } from "./machine-counts.ts";
import { studioTenant } from "./testing/durable-image-fixtures.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

async function addDecisionWithReview(sql: Sql, tenant: { organizationId: string; brandId: string }, status: string) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const decisionId = `jev-mc-${suffix}`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${tenant.organizationId}, ${tenant.brandId}, ${`corr-${suffix}`}, 'opportunity_gate.v2', '2', 'creative', ${`subj-${suffix}`},
      '{}', '[]', 0.6, 0.7, '{}', 'HUMAN_REVIEW', '[]'
    )
  `;
  await sql`
    insert into reviews (id, organization_id, brand_id, decision_id, subject_label, status)
    values (${`rev-mc-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, ${decisionId}, 'label', ${status})
  `;
}

/**
 * The counts describe one brand. A decided review is one a person approved or rejected, and an open review is waiting. Another
 * workspace's records are not counted. The fixture already has one brief and one decision.
 */
async function countsDescribeOneBrand(sql: Sql) {
  const tenant = await studioTenant(sql, `counts-${Math.random().toString(36).slice(2, 8)}`);
  const other = await studioTenant(sql, `counts-other-${Math.random().toString(36).slice(2, 8)}`);
  await addDecisionWithReview(sql, tenant, "approved");
  await addDecisionWithReview(sql, tenant, "rejected");
  await addDecisionWithReview(sql, tenant, "open");
  await addDecisionWithReview(sql, other, "approved");
  await addDecisionWithReview(sql, other, "open");
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by)
    values (${`cr-own-${tenant.brandId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'own', 'approved', ${tenant.userId}),
           (${`cr-comp-${tenant.brandId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'competitor', 'comp', 'approved', ${tenant.userId})
  `;

  const counts = await loadMachineCounts(sql, tenant.organizationId, tenant.brandId);
  assert.equal(counts.decidedReviews, 2, "approved and rejected reviews are decided");
  assert.equal(counts.reviews, 1, "the one open review is counted as open");
  assert.equal(counts.decisions, 4, "the fixture decision plus the three added for this brand, and none of the other workspace's");
  assert.equal(counts.briefs, 1, "the fixture brief, and not the other workspace's");
  assert.equal(counts.creatives, 1, "own creatives only");
  assert.equal(counts.observations, 1, "competitor observations only");

  const empty = await loadMachineCounts(sql, other.organizationId, `missing-${tenant.brandId}`);
  assert.equal(empty.decidedReviews, 0, "a brand that does not exist, or is not this workspace's, has zero, not an error");
  assert.equal(empty.decisions, 0);
  const wrongWorkspace = await loadMachineCounts(sql, other.organizationId, tenant.brandId);
  assert.equal(wrongWorkspace.decidedReviews, 0, "a brand's counts are not read through another workspace");
  assert.equal(wrongWorkspace.reviews, 0);
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the machine counts are scoped to one brand and one workspace on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL counts check was not run");
      return;
    }
    if (target === "PGlite") {
      await countsDescribeOneBrand(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await countsDescribeOneBrand(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
