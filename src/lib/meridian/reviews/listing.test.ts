import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { REVIEW_PAGE_MAX, REVIEW_PAGE_SIZE, loadReviewPage, reviewPage, reviewsHaveMore } from "./listing.ts";
import { REVIEW_REASON_CODES, REVIEW_REASON_LABELS, isReviewReasonCode, reviewReasonOptions } from "./reasons.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

test("a page request is clamped to a usable window", () => {
  assert.deepEqual(reviewPage({}), { offset: 0, limit: REVIEW_PAGE_SIZE });
  assert.deepEqual(reviewPage({ offset: "80", limit: "20" }), { offset: 80, limit: 20 });
  assert.deepEqual(reviewPage({ limit: 10_000 }), { offset: 0, limit: REVIEW_PAGE_MAX }, "a huge limit is capped");
  assert.deepEqual(reviewPage({ limit: 0 }), { offset: 0, limit: 1 }, "a zero limit becomes one row");
  assert.deepEqual(reviewPage({ offset: -5, limit: Number.NaN }), { offset: 0, limit: REVIEW_PAGE_SIZE }, "bad values fall back");
});

test("more rows are reported only when rows exist after the page", () => {
  assert.equal(reviewsHaveMore({ offset: 0, returned: 40, total: 41 }), true);
  assert.equal(reviewsHaveMore({ offset: 40, returned: 1, total: 41 }), false);
  assert.equal(reviewsHaveMore({ offset: 0, returned: 0, total: 0 }), false);
});

test("every reason code has a label, and the options follow the server's order", () => {
  for (const code of REVIEW_REASON_CODES) assert.ok(REVIEW_REASON_LABELS[code].length > 0, `${code} has a label`);
  assert.deepEqual(reviewReasonOptions().map((option) => option.code), [...REVIEW_REASON_CODES]);
  assert.equal(reviewReasonOptions().find((option) => option.code === "wrong_logo")?.label, REVIEW_REASON_LABELS.wrong_logo);
  assert.equal(isReviewReasonCode("wrong_logo"), true);
  assert.equal(isReviewReasonCode("made_up_reason"), false, "a code outside the list is refused");
});

/** Creates a review with a decision. The decision row has the shape the decision store writes. */
async function addReview(sql: Sql, tenant: { organizationId: string; brandId: string; userId: string }, label: string, status: string, createdAt: string) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const decisionId = `jev-rev-${suffix}`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${tenant.organizationId}, ${tenant.brandId}, ${`corr-${suffix}`}, 'opportunity_gate.v2', '2', 'creative', ${`subj-${suffix}`},
      '{}', '[]', 0.6, 0.7, '{}', 'HUMAN_REVIEW', '["fixture reason"]'
    )
  `;
  await sql`
    insert into reviews (id, organization_id, brand_id, decision_id, subject_label, status, created_at)
    values (${`rev-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, ${decisionId}, ${label}, ${status}, ${createdAt}::timestamptz)
  `;
  return `rev-${suffix}`;
}

/** Pages walk the newest rows first, with exact totals, and a page boundary neither repeats nor drops a row. */
async function pagesWalkTheListWithExactTotals(sql: Sql) {
  const tenant = await studioTenant(sql, `reviews-${Math.random().toString(36).slice(2, 8)}`);
  const other = await studioTenant(sql, `reviews-other-${Math.random().toString(36).slice(2, 8)}`);
  const first = await addReview(sql, tenant, "oldest open", "open", "2026-01-01T00:00:00Z");
  const second = await addReview(sql, tenant, "approved one", "approved", "2026-01-02T00:00:00Z");
  const third = await addReview(sql, tenant, "newest rejected", "rejected", "2026-01-03T00:00:00Z");
  await addReview(sql, other, "another workspace", "open", "2026-01-04T00:00:00Z");

  const page1 = await loadReviewPage(sql, tenant.organizationId, tenant.brandId, { offset: 0, limit: 2 });
  assert.deepEqual(page1.rows.map((row) => row.id), [third, second], "newest first");
  assert.equal(page1.total, 3, "total counts every review of the brand, not the page");
  assert.equal(page1.openTotal, 1);
  assert.equal(page1.decidedTotal, 2, "approved and rejected reviews are decided");
  assert.equal(page1.hasMore, true);

  const page2 = await loadReviewPage(sql, tenant.organizationId, tenant.brandId, { offset: 2, limit: 2 });
  assert.deepEqual(page2.rows.map((row) => row.id), [first], "the next page starts where the last one ended");
  assert.equal(page2.hasMore, false);
  assert.equal(page2.total, 3);

  const past = await loadReviewPage(sql, tenant.organizationId, tenant.brandId, { offset: 10, limit: 2 });
  assert.equal(past.rows.length, 0);
  assert.equal(past.total, 3, "a page past the end still reports the total");
  assert.equal(past.hasMore, false);
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the review list pages with exact totals on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL review paging check was not run");
      return;
    }
    if (target === "PGlite") {
      await pagesWalkTheListWithExactTotals(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await pagesWalkTheListWithExactTotals(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
