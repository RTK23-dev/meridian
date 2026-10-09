import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { modelLimit, refuseIfLimited } from "@/lib/meridian/security/limits";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

export const getStudioSession = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.getStudioSession(context.userId, data);
  });

export const openStudioBrief = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { brandId?: unknown; forceNew?: unknown }) : {};
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, forceNew: body.forceNew === true };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.openStudioBrief(context.userId, data);
  });

import { serverStudioGenerationSchema } from "@/lib/meridian/schemas/studio-generation";

export const generateStudioVariants = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = (input && typeof input === "object" ? { ...input } : {}) as Record<string, unknown>;
    if (raw.videoProvider === "omni") {
      raw.videoProvider = "google_omni";
    }
    if (raw.videoProvider === "veo") {
      throw new Error("Google Veo 3.1 (Preview) is deprecated and shut down. Please select Google Gemini Omni (google_omni).");
    }
    if (!raw.imageProvider) raw.imageProvider = "none";
    if (!raw.videoProvider) raw.videoProvider = "none";

    const validated = serverStudioGenerationSchema.parse(raw);
    return {
      ...validated,
      videoProvider: validated.videoProvider === "omni" ? "google_omni" : validated.videoProvider,
      mode: validated.mode as import("@/lib/meridian/factory/creative-manifest").CreationMode | undefined,
      source: validated.source as import("@/lib/meridian/factory/creative-manifest").StartingMaterialType | undefined,
      productionMode: validated.productionMode as import("@/lib/meridian/factory/creative-manifest").ProductionStrategyType | undefined,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    refuseIfLimited(modelLimit, context.userId);
    const api = await import("./session.server");
    return api.generateStudioVariants(context.userId, data);
  });

export const approveAndExecuteCreativePlan = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const planId = clip(body.planId);
    if (!brandId || !planId) throw new Error("Choose a valid brand and creative plan.");
    return { brandId, planId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    refuseIfLimited(modelLimit, context.userId);
    const api = await import("./session.server");
    return api.approveAndExecuteCreativePlan(context.userId, data);
  });

export const rejectCreativePlan = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const planId = clip(body.planId);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : undefined;
    if (!brandId || !planId) throw new Error("Choose a valid brand and creative plan.");
    return { brandId, planId, reason };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    refuseIfLimited(modelLimit, context.userId);
    const api = await import("./session.server");
    return api.rejectCreativePlan(context.userId, data);
  });

export const reviewStudioVariant = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const action = clip(body.action);
    if (action !== "approve" && action !== "reject" && action !== "revision") throw new Error("Choose approve, reject, or revision.");
    const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim().slice(0, 40) : "";
    if (action === "reject" && !reasonCode) throw new Error("Choose a rejection reason.");
    const brandId = clip(body.brandId);
    const creativeId = clip(body.creativeId);
    if (!brandId || !creativeId) throw new Error("Choose a variant.");
    return { brandId, creativeId, action, reasonCode, note: typeof body.note === "string" ? body.note.trim().slice(0, 400) : "" };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.reviewStudioVariant(context.userId, data);
  });

export const publishStudioVariant = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const creativeId = clip(body.creativeId);
    const publisher = clip(body.publisher);
    if (!brandId || !creativeId) throw new Error("Choose a variant.");
    if (publisher !== "test") throw new Error("No live publisher is connected. Select the test publisher to record a test id, or connect an ad account.");
    return { brandId, creativeId, publisher };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.publishStudioVariant(context.userId, data);
  });

export const recordStudioTestPerformance = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.recordStudioTestPerformance(context.userId, data);
  });
