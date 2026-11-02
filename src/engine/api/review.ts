// The open review items of a brand's engine requests. Moved out of engine/api/index.ts unchanged (coding loop, T8).
// index.ts re-exports the public names.

import { z } from "zod";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { takeReviewItemSchema } from "../review/inbox.ts";

// --- Review inbox ----------------------------------------------------------------------------------------------------------

export type EngineReviewItem = {
  id: string;
  requestId: string;
  kind: "escalation" | "dead_letter" | "sample";
  /** The shot, take, EDL or request the item is about. */
  subjectId: string;
  /** Built by engine code from rule names and routes, never from model prose. */
  reason: string;
  /** What the payload says, read through its contract. Fields the payload does not carry are absent. */
  shotId?: string;
  stage?: string;
  takeCount?: number;
  createdAt: string;
};

const detailStageSchema = z.object({ stage: z.string().min(1).max(60) });

/** The open review items of a brand's requests, newest first. Tenancy: the workspace and the brand of each request. */

export async function openEngineReviewItems(sql: Sql, organizationId: string, brandId: string, limit = 50): Promise<EngineReviewItem[]> {
  const rows = await sql<{ id: string; request_id: string; kind: string; subject_id: string; reason: string; detail: string; created_at: unknown }>`
    select i.id, i.request_id, i.kind, i.subject_id, i.reason, i.detail, i.created_at
    from engine_review_items i
    join engine_requests r on r.id = i.request_id and r.organization_id = i.organization_id
    where i.organization_id = ${organizationId} and r.brand_id = ${brandId} and i.status = 'open'
    order by i.created_at desc, i.id desc
    limit ${Math.min(Math.max(Math.trunc(limit), 1), 200)}
  `;
  return rows.flatMap((row) => {
    if (row.kind !== "escalation" && row.kind !== "dead_letter" && row.kind !== "sample") return [];
    const item: EngineReviewItem = {
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      subjectId: row.subject_id,
      reason: row.reason,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    };
    let detail: unknown = null;
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = null;
    }
    const take = takeReviewItemSchema.safeParse(detail);
    if (take.success) {
      item.shotId = take.data.shotId;
      item.takeCount = take.data.takes.length;
    }
    const staged = detailStageSchema.safeParse(detail);
    if (staged.success) item.stage = staged.data.stage;
    return [item];
  });
}
