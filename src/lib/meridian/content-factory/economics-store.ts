// The runs and ledger lines of one brand, read from the engine's tables (economics.ts does the arithmetic). Scoped to the workspace and the
// brand. A ledger line's amount is read as it was settled: the actual is null for a held call and is never estimated here.

import type { Sql } from "../learning/store.ts";
import type { LedgerLine, RunRecord } from "./economics.ts";

export async function readBrandRuns(sql: Sql, organizationId: string, brandId: string): Promise<RunRecord[]> {
  const rows = await sql<{ id: string; status: string }>`
    select id, status from engine_requests where organization_id = ${organizationId} and brand_id = ${brandId} and format_id <> 'fmt_demo'
  `;
  return rows.map((row) => ({ requestId: row.id, delivered: row.status === "delivered" }));
}

export async function readBrandLedger(sql: Sql, organizationId: string, brandId: string): Promise<LedgerLine[]> {
  const rows = await sql<{ request_id: string; estimate_usd: unknown; actual_usd: unknown; settlement: string | null }>`
    select l.request_id, l.estimate_usd, l.actual_usd, l.settlement
    from engine_ledger l
    join engine_requests r on r.organization_id = l.organization_id and r.id = l.request_id
    where l.organization_id = ${organizationId} and r.brand_id = ${brandId} and r.format_id <> 'fmt_demo'
  `;
  return rows.map((row) => ({
    requestId: row.request_id,
    estimateUsd: Number(row.estimate_usd ?? 0),
    actualUsd: row.actual_usd === null || row.actual_usd === undefined ? null : Number(row.actual_usd),
    settlement: row.settlement === "billed" || row.settlement === "confirmed_absent" ? row.settlement : null,
  }));
}
