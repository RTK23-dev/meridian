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

export const generateStudioVariants = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const briefId = clip(body.briefId);
    const imageProvider = clip(body.imageProvider);
    const videoProvider = clip(body.videoProvider);
    const mode = clip(body.mode);
    const creationScope = clip(body.creationScope);
    const autonomy = clip(body.autonomy);
    const source = clip(body.source);
    const productionMode = clip(body.productionMode);
    const aspectRatio = clip(body.aspectRatio);

    if (!brandId || !briefId) throw new Error("Choose a brief.");
    if (imageProvider && imageProvider !== "none" && imageProvider !== "test:image" && imageProvider !== "google:nano-banana") {
      throw new Error("Choose no image provider or an optional supported image provider.");
    }
    const isTestRuntime = process.env.NODE_ENV === "test" || process.env.MERIDIAN_TESTING_RUNTIME === "true";
    const allowedVideoProviders = new Set([
      "none",
      "auto",
      "manual_cloud",
      "veo",
      "higgsfield",
      "hypit",
      "omni",
      "google_omni",
      ...(isTestRuntime ? ["test:video"] : []),
    ]);
    if (videoProvider === "veo") {
      throw new Error("Google Veo 3.1 (Preview) is deprecated and shut down. Please select Google Gemini Omni (google_omni).");
    }
    const canonicalVideoProvider = videoProvider === "omni" ? "google_omni" : videoProvider;
    if (canonicalVideoProvider && !allowedVideoProviders.has(canonicalVideoProvider)) {
      throw new Error(`Unsupported video provider: ${canonicalVideoProvider}. Allowed: auto, manual_cloud, higgsfield, hypit, google_omni, none.`);
    }
    const maxSpendUsd = typeof body.maxSpendUsd === "number" && !Number.isNaN(body.maxSpendUsd) ? body.maxSpendUsd : undefined;
    return {
      brandId,
      briefId,
      imageProvider: imageProvider || "none",
      videoProvider: canonicalVideoProvider || "none",
      mode: (mode || (canonicalVideoProvider && canonicalVideoProvider !== "none" ? "video" : "image_ad")) as import("@/lib/meridian/factory/creative-manifest").CreationMode,
      creationScope: creationScope as import("@/lib/meridian/creative/plan").CreationScope | undefined,
      autonomy: autonomy as import("@/lib/meridian/creative/plan").AutonomyMode | undefined,
      maxSpendUsd,
      source: (source || "new_brief") as import("@/lib/meridian/factory/creative-manifest").StartingMaterialType,
      productionMode: (productionMode || (canonicalVideoProvider === "manual_cloud" ? "manual_cloud" : "automated_provider")) as import("@/lib/meridian/factory/creative-manifest").ProductionStrategyType,
      aspectRatio: (aspectRatio === "16:9" || aspectRatio === "1:1" ? aspectRatio : "9:16") as "9:16" | "16:9" | "1:1" | "4:5",
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
