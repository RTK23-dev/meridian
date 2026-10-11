/**
 * The review list for one brand: a page of rows, newest first, with the totals the screen needs to say what is loaded.
 * Plain SQL with no server-function imports, so the listing can be tested directly on PGlite and PostgreSQL.
 */
import type { Sql } from "../learning/store.ts";

export const REVIEW_PAGE_SIZE = 40;
export const REVIEW_PAGE_MAX = 200;

/**
 * A page request. The limit is clamped to 1..REVIEW_PAGE_MAX and the offset to zero or more, so a bad value from the
 * client becomes a usable page instead of an error or a query over every row.
 */
export function reviewPage(input: { offset?: unknown; limit?: unknown }): { offset: number; limit: number } {
  const offset = toInteger(input.offset, 0);
  const limit = toInteger(input.limit, REVIEW_PAGE_SIZE);
  return {
    offset: Math.min(Math.max(offset, 0), 1_000_000),
    limit: Math.min(Math.max(limit, 1), REVIEW_PAGE_MAX),
  };
}

function toInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export type ReviewPageResult = {
  rows: Record<string, unknown>[];
  /** Every review the brand holds, of any status, that has a decision. */
  total: number;
  openTotal: number;
  decidedTotal: number;
  /** True when rows exist after this page. */
  hasMore: boolean;
};

/** True when a page that starts at `offset` and returned `returned` rows leaves rows behind it in a list of `total`. */
export function reviewsHaveMore(input: { offset: number; returned: number; total: number }): boolean {
  return input.offset + input.returned < input.total;
}

/**
 * One page of the brand's reviews and the three totals. Rows are ordered by creation time, then id, so a page boundary never
 * repeats or skips a row. A review without a decision is not listed, because the screen cannot explain it.
 */
export async function loadReviewPage(
  sql: Sql,
  organizationId: string,
  brandId: string,
  page: { offset: number; limit: number },
): Promise<ReviewPageResult> {
  const rows = await sql<Record<string, unknown>>`
    select r.id, r.subject_label, r.status, r.creative_id, r.opportunity_id, r.created_at,
           d.decision, d.probability, d.confidence, d.reasons, d.question_id, d.question_version, d.answer, d.policy_version
    from reviews r
    join jev_decisions d on d.id = r.decision_id
    where r.brand_id = ${brandId} and r.organization_id = ${organizationId}
    order by r.created_at desc, r.id desc
    limit ${page.limit} offset ${page.offset}
  `;
  const totals = await sql<{ total: number; open_total: number; decided_total: number }>`
    select count(*)::int as total,
           count(*) filter (where r.status = 'open')::int as open_total,
           count(*) filter (where r.status in ('approved', 'rejected'))::int as decided_total
    from reviews r
    join jev_decisions d on d.id = r.decision_id
    where r.brand_id = ${brandId} and r.organization_id = ${organizationId}
  `;
  const total = Number(totals[0]?.total ?? 0);
  return {
    rows,
    total,
    openTotal: Number(totals[0]?.open_total ?? 0),
    decidedTotal: Number(totals[0]?.decided_total ?? 0),
    hasMore: reviewsHaveMore({ offset: page.offset, returned: rows.length, total }),
  };
}
