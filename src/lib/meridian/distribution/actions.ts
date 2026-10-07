import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  listAvailableChannels,
  publishCreativeToChannels,
  listOrganicPosts,
  recordOrganicTelemetryAndLearn,
  requireBrandAccess,
} from "./service.ts";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export const getDistributionChannels = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");
    return listAvailableChannels(sql, access.organizationId, data.brandId);
  });

export const publishMultiChannelVariant = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const creativeId = clip(body.creativeId);
    const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 1000) : "";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    const scheduledFor = typeof body.scheduledFor === "string" ? body.scheduledFor.trim() : undefined;
    const channelIds = Array.isArray(body.channelIds)
      ? body.channelIds.map((item) => clip(item)).filter(Boolean)
      : [];

    if (!brandId || !creativeId) throw new Error("Choose a creative variant to publish.");
    if (channelIds.length === 0) throw new Error("Select at least one destination channel.");

    return { brandId, creativeId, channelIds, caption, title, scheduledFor };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");
    return publishCreativeToChannels(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      creativeId: data.creativeId,
      channelIds: data.channelIds,
      caption: data.caption,
      title: data.title,
      scheduledFor: data.scheduledFor,
      userId: context.userId,
    });
  });

export const getOrganicDistribution = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");
    return listOrganicPosts(sql, access.organizationId, data.brandId);
  });

export const recordOrganicTelemetryAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");
    return recordOrganicTelemetryAndLearn(sql, access.organizationId, data.brandId, context.userId);
  });
