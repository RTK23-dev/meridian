import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrandAccess } from "../distribution/service.ts";
import {
  scheduleMultiAccountPublish,
  listBrandPublishingQueue,
  listBrandPublishingReceipts,
  cancelPublishJob,
  retryPublishJob,
  type QueueStatus,
  type TargetType,
} from "./orchestrator.ts";

function clip(value: unknown, maxLen = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLen) : "";
}

/**
 * Schedules a creative variant to publish across multiple platform accounts.
 * Member role required.
 */
export const scheduleMultiAccountPublishAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const creativeId = clip(body.creativeId);
    const targetAccountIds = Array.isArray(body.targetAccountIds)
      ? body.targetAccountIds.map((id) => clip(id)).filter(Boolean)
      : [];
    const scheduledTime = typeof body.scheduledTime === "string" ? body.scheduledTime.trim() : undefined;
    const targetType = (clip(body.targetType) as TargetType) || "organic";

    if (!brandId) throw new Error("Choose a brand.");
    if (!creativeId) throw new Error("Select a creative variant.");
    if (targetAccountIds.length === 0) throw new Error("Select at least one destination account.");

    return { brandId, creativeId, targetAccountIds, scheduledTime, targetType };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");

    return scheduleMultiAccountPublish(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      creativeId: data.creativeId,
      targetAccountIds: data.targetAccountIds,
      scheduledTime: data.scheduledTime,
      targetType: data.targetType,
    });
  });

/**
 * Lists publishing queue items for a brand. Viewer role required.
 */
export const listPublishingQueueAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const status = typeof body.status === "string" ? (clip(body.status) as QueueStatus) : undefined;
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, status };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");
    const [queue, receipts] = await Promise.all([
      listBrandPublishingQueue(sql, access.organizationId, data.brandId, { status: data.status }),
      listBrandPublishingReceipts(sql, access.organizationId, data.brandId, { limit: 20 }),
    ]);

    return {
      role: access.role,
      queue,
      receipts,
    };
  });

/**
 * Cancels a queued publishing job. Member role required.
 */
export const cancelPublishJobAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const queueId = clip(body.queueId);
    if (!brandId) throw new Error("Choose a brand.");
    if (!queueId) throw new Error("Select a queue item.");
    return { brandId, queueId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");
    const cancelled = await cancelPublishJob(sql, access.organizationId, data.brandId, data.queueId);
    return { ok: cancelled };
  });

/**
 * Retries a failed publishing job immediately. Member role required.
 */
export const retryPublishJobAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const queueId = clip(body.queueId);
    if (!brandId) throw new Error("Choose a brand.");
    if (!queueId) throw new Error("Select a queue item.");
    return { brandId, queueId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");
    const retried = await retryPublishJob(sql, access.organizationId, data.brandId, data.queueId);
    return { ok: retried };
  });
