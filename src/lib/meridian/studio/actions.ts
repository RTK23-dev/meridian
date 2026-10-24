import type { HeldReservationResolution } from "../security/held-reservations.ts";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { enforceNamedLimit } from "@/lib/meridian/security/limits";
import { parseVariantReview } from "./variant-review-input.ts";

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
    const body = input && typeof input === "object" ? (input as { brandId?: unknown; forceNew?: unknown; reason?: unknown; opportunityId?: unknown }) : {};
    const brandId = clip(body.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    // The reason for accepting the direction is required. The brief-open module checks its length.
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 4000) : "";
    // An optional opportunity to brief. Its tenancy is checked in brief-open.server.ts, never trusted from here.
    const opportunityId = typeof body.opportunityId === "string" ? body.opportunityId.trim().slice(0, 80) : "";
    return { brandId, forceNew: body.forceNew === true, reason, opportunityId: opportunityId || undefined };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    // Accepting a direction runs the brief gate, a model call, so it shares the model limit with the other Studio generation actions.
    await enforceNamedLimit("model", context.userId);
    const [{ getSql }, api, session] = await Promise.all([
      import("../../db.ts"),
      import("./brief-open.server.ts"),
      import("./session.server.ts"),
    ]);
    await api.openStudioBriefFor(await getSql(), context.userId, data);
    return session.getStudioSession(context.userId, { brandId: data.brandId });
  });

import { serverStudioGenerationSchema } from "@/lib/meridian/schemas/studio-generation";
import type { FrameEdit } from "../brief/frame.ts";

/**
 * A person's edit of a ready brief's frame (prompt 14). Only the fields sent are changed; a field sent as null returns to not set. The
 * copy is not an input here: it is judged as written.
 */
export const updateStudioBriefFrame = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    // A field sent as null returns to not set. Any other type is refused, never turned into a clear (review finding, frame edits).
    const edit: FrameEdit = {};
    if ("platform" in body) {
      if (body.platform !== null && typeof body.platform !== "string") throw new Error("The platform must be text.");
      edit.platform = body.platform;
    }
    if ("budgetUsd" in body) {
      if (body.budgetUsd !== null && (typeof body.budgetUsd !== "number" || !Number.isFinite(body.budgetUsd))) {
        throw new Error("The budget must be a number of dollars.");
      }
      edit.budgetUsd = body.budgetUsd;
    }
    if ("visualReferences" in body) {
      if (body.visualReferences !== null && !Array.isArray(body.visualReferences)) throw new Error("The visual references must be a list.");
      edit.visualReferences = Array.isArray(body.visualReferences)
        ? body.visualReferences.filter((item): item is string => typeof item === "string")
        : null;
    }
    if ("successCriteria" in body) {
      if (body.successCriteria !== null && typeof body.successCriteria !== "string") throw new Error("The success criteria must be text.");
      edit.successCriteria = body.successCriteria;
    }
    return { brandId: clip(body.brandId), briefId: clip(body.briefId), edit };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!data.brandId || !data.briefId) throw new Error("Choose a brief in a brand.");
    const [{ getSql }, api] = await Promise.all([import("../../db.ts"), import("./brief-frame.server.ts")]);
    return api.updateBriefFrame(await getSql(), context.userId, data);
  });

/** The disclosure for a brief the engine could not judge: the failure, the unresolved questions, and the evidence. */
export const getStudioBriefReview = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { brandId?: unknown; briefId?: unknown }) : {};
    const brandId = clip(body.brandId);
    const briefId = clip(body.briefId);
    if (!brandId || !briefId) throw new Error("Choose a brief.");
    return { brandId, briefId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const [{ getSql }, api] = await Promise.all([import("../../db.ts"), import("./brief-review-access.server.ts")]);
    return api.getBriefReviewForUser(await getSql(), context.userId, data);
  });

/** The explicit review of a held brief. Approval or rejection is a separate action, with an acknowledgement and a reason. */
export const reviewStudioBrief = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const briefId = clip(body.briefId);
    if (!brandId || !briefId) throw new Error("Choose a brief.");
    if (body.action !== "approve" && body.action !== "reject") throw new Error("Choose approve or reject.");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 4000) : "";
    return { brandId, briefId, action: body.action as "approve" | "reject", reason, acknowledged: body.acknowledged === true };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const [{ getSql }, api] = await Promise.all([import("../../db.ts"), import("./brief-review-access.server.ts")]);
    return api.reviewBriefForUser(await getSql(), context.userId, data);
  });

export const generateStudioVariants = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = (input && typeof input === "object" ? { ...input } : {}) as Record<string, unknown>;
    if (raw.videoProvider === "omni") {
      raw.videoProvider = "google_omni";
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
    await enforceNamedLimit("model", context.userId);
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
    await enforceNamedLimit("model", context.userId);
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
    await enforceNamedLimit("model", context.userId);
    const api = await import("./session.server");
    return api.rejectCreativePlan(context.userId, data);
  });

export const reviewStudioVariant = createServerFn({ method: "POST" })
  // A rejection must name a reason code from the server list. The check is in variant-review-input.ts, with its test.
  .validator((input: unknown) => parseVariantReview(input && typeof input === "object" ? (input as Record<string, unknown>) : {}))
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

export const listHeldBudgetReservations = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { getSql } = await import("../../db.ts");
    const api = await import("../security/held-reservations.ts");
    return api.listHeldReservations(await getSql(), context.userId, data.brandId);
  });

/** The reservations the window sweep released in this brand, with the reason and the actor it recorded. Admin only. */
export const listWindowReleasedBudget = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = clip((input as { brandId?: unknown })?.brandId);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { getSql } = await import("../../db.ts");
    const api = await import("../security/held-reservations.ts");
    return api.listWindowReleases(await getSql(), context.userId, data.brandId);
  });

export const resolveHeldBudgetReservation = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const brandId = clip(raw.brandId);
    const reservationId = clip(raw.reservationId);
    if (!brandId || !reservationId) throw new Error("Choose a held reservation.");
    const resolution: HeldReservationResolution | null =
      raw.resolution === "not_accepted" || raw.resolution === "billed_no_artifact" ? raw.resolution : null;
    if (!resolution) throw new Error("Choose how the provider outcome was resolved.");
    return {
      brandId,
      reservationId,
      resolution,
      note: typeof raw.note === "string" ? raw.note.trim() : "",
      providerReference: typeof raw.providerReference === "string" ? raw.providerReference.trim() : undefined,
      observedSpendUsd: typeof raw.observedSpendUsd === "number" ? raw.observedSpendUsd : undefined,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { getSql } = await import("../../db.ts");
    const api = await import("../security/held-reservations.ts");
    return api.resolveHeldReservation(await getSql(), context.userId, data);
  });
