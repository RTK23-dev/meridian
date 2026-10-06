import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

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
    if (!brandId || !briefId) throw new Error("Choose a brief.");
    if (imageProvider !== "test:image" && imageProvider !== "xai:image") {
      throw new Error("Choose an image provider. test:image is explicit and off until you select it.");
    }
    if (videoProvider !== "test:video") {
      throw new Error("Choose a video provider. test:video is explicit. No live video vendor is connected.");
    }
    return { brandId, briefId, imageProvider, videoProvider };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const api = await import("./session.server");
    return api.generateStudioVariants(context.userId, data);
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
