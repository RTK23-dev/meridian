import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrandAccess } from "../distribution/service.ts";
import {
  recordTelemetry,
  getTelemetryRecords,
  summarizeTelemetry,
  syncTelemetryToLearning,
  type TelemetryRecordInput,
  type TelemetrySourceType,
} from "./telemetry-engine.ts";

function clip(value: unknown, maxLen = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLen) : "";
}

/**
 * Records performance telemetry for a brand.
 * Member role required.
 */
export const recordTelemetryAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");

    const platform = clip(body.platform);
    if (!platform) throw new Error("Platform is required.");

    const sourceType = (clip(body.sourceType) as TelemetrySourceType) || "organic";
    const creativeId = clip(body.creativeId);
    const variantId = clip(body.variantId);
    const externalPostId = clip(body.externalPostId);
    const hookType = clip(body.hookType);
    const angle = clip(body.angle);
    const format = clip(body.format);

    function optionalNumber(value: unknown): number | null {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    const views = optionalNumber(body.views);
    const impressions = optionalNumber(body.impressions);
    const reach = optionalNumber(body.reach);
    const clicks = optionalNumber(body.clicks);
    const engagements = optionalNumber(body.engagements);
    const shares = optionalNumber(body.shares);
    const saves = optionalNumber(body.saves);
    const conversions = optionalNumber(body.conversions);
    const spendCents = optionalNumber(body.spendCents);
    const revenueCents = optionalNumber(body.revenueCents);
    const hookRetention3s = optionalNumber(body.hookRetention3s);
    const completionRate = optionalNumber(body.completionRate);

    return {
      brandId,
      platform,
      sourceType,
      creativeId,
      variantId,
      externalPostId,
      hookType,
      angle,
      format,
      views,
      impressions,
      reach,
      clicks,
      engagements,
      shares,
      saves,
      conversions,
      spendCents,
      revenueCents,
      hookRetention3s,
      completionRate,
      publishJobId: typeof body.publishJobId === "string" ? body.publishJobId : null,
      accountId: typeof body.accountId === "string" ? body.accountId : null,
      recordedAt: typeof body.recordedAt === "string" ? body.recordedAt : undefined,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");

    const input: TelemetryRecordInput = {
      organizationId: access.organizationId,
      brandId: data.brandId,
      publishJobId: data.publishJobId,
      accountId: data.accountId,
      platform: data.platform,
      sourceType: data.sourceType,
      creativeId: data.creativeId,
      variantId: data.variantId,
      externalPostId: data.externalPostId,
      hookType: data.hookType,
      angle: data.angle,
      format: data.format,
      views: data.views,
      impressions: data.impressions,
      reach: data.reach,
      clicks: data.clicks,
      engagements: data.engagements,
      shares: data.shares,
      saves: data.saves,
      conversions: data.conversions,
      spendCents: data.spendCents,
      revenueCents: data.revenueCents,
      hookRetention3s: data.hookRetention3s,
      completionRate: data.completionRate,
      recordedAt: data.recordedAt,
    };

    return recordTelemetry(sql, input);
  });

/**
 * Returns telemetry records, summary, and Bayesian feature posteriors for a brand.
 * Viewer role required.
 */
export const getTelemetrySummaryAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");

    const platform = clip(body.platform) || undefined;
    const sourceType = (clip(body.sourceType) as TelemetrySourceType) || undefined;
    const limit = Number(body.limit) || 100;

    return { brandId, platform, sourceType, limit };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");

    const records = await getTelemetryRecords(sql, access.organizationId, data.brandId, {
      platform: data.platform,
      sourceType: data.sourceType,
      limit: data.limit,
    });

    const summary = summarizeTelemetry(records);
    return {
      records,
      summary,
    };
  });

/**
 * Triggers closed-loop feedback: updates Bayesian pattern tables and JEV account profiles.
 * Member role required.
 */
export const syncTelemetryPriorsAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");

    return syncTelemetryToLearning(sql, access.organizationId, data.brandId);
  });
