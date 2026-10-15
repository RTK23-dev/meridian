/**
 * The video engine's open review items for one brand, as the Reviews inbox shows them (lead task I3). The engine writes its own items
 * (escalations, stopped jobs and samples); Meridian reads them through the engine's API and never changes them here. Each item keeps the
 * engine's reason, which the engine builds from rule names and routes, never from model prose. Tenancy: the workspace and the brand of each
 * request are checked by the engine's query, so another brand's items are never listed.
 */
import type { Sql } from "../learning/store.ts";
import { openEngineReviewItems, type EngineReviewItem } from "../../../engine/api/index.ts";

export type EngineInboxItem = {
  id: string;
  requestId: string;
  kind: "escalation" | "dead_letter" | "sample";
  subjectId: string;
  /** What the inbox shows as the item's title: the kind, and the stage it is at when the engine says so. */
  label: string;
  /** The engine's reason, as the engine wrote it. */
  reason: string;
  stage: string | null;
  shotId: string | null;
  takeCount: number | null;
  createdAt: string;
};

const KIND_LABEL: Record<EngineInboxItem["kind"], string> = {
  escalation: "Escalated by the video engine",
  dead_letter: "Stopped by an error in the video engine",
  sample: "Sampled for the engine's gold labels",
};

/** One engine review item as the inbox row. The label names the kind and, when the engine gives one, the stage. */
export function engineInboxItemOf(item: EngineReviewItem): EngineInboxItem {
  const stage = item.stage ?? null;
  return {
    id: item.id,
    requestId: item.requestId,
    kind: item.kind,
    subjectId: item.subjectId,
    label: stage ? `${KIND_LABEL[item.kind]} at ${stage}` : KIND_LABEL[item.kind],
    reason: item.reason,
    stage,
    shotId: item.shotId ?? null,
    takeCount: item.takeCount ?? null,
    createdAt: item.createdAt,
  };
}

/** The open engine review items of a brand, newest first. An empty list is "nothing is open", never a failure. */
export async function engineInboxItems(sql: Sql, organizationId: string, brandId: string, limit = 50): Promise<EngineInboxItem[]> {
  const items = await openEngineReviewItems(sql, organizationId, brandId, limit);
  return items.map(engineInboxItemOf);
}
