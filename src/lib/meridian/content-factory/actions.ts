import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  attachSourceInput,
  brandHookInput,
  createSessionInput,
  opportunityBriefInput,
  messageInput,
  repurposeInput,
  repurposeOutputInput,
  repurposeOrganicInput,
  pausedAdChoicesInput,
  pausedAdInput,
  repurposeReviewInput,
  repurposeRunInput,
  remakeShotInput,
  clipInput,
  reviseDirectionInput,
  shotDecisionInput,
  shotRefInput,
  sessionInput,
  settingsInput,
  sourceSearchInput,
  uploadInput,
  sessionsListInput,
} from "./input.ts";
import { createBatch, getBatch, listBatches, retryBatchItem, startBatch } from "./batch-service.ts";
import { createVariations } from "./variation-service.ts";
import { repurposeOutputLink, repurposePreview, startRepurpose } from "./repurpose.ts";
import { recordRepurposeReview, repurposeReviewsOf } from "./repurpose-review.ts";
import { checkInterruptedRepurposeRender } from "./repurpose-status.ts";
import { uploadRepurposeVariantToMeta } from "./repurpose-upload-service.ts";
import { createRepurposedPausedAd, listPausedAdChoices } from "./repurpose-paused-ad.ts";
import { listRepurposeFacebookPages, loadRepurposedMedia, publishRepurposedVariantToFacebookPage } from "./repurpose-organic.ts";
import { measureRepurposeRun } from "../measurement/repurpose-pull.ts";
import { productionRepurposeRenderPort, productionRepurposeStatusPoll } from "./repurpose-production.ts";
import { attachSource, brandEconomics, brandHookHistory, briefFromOpportunity, createSession, deliveredMasterLink, deliveryApprovalOf, getSession, listSessions, postMessage, readRun, recordDeliveryApproval, remakeShot, reviseWithDirection, shotClip, shotClipQuote, shotDecision, shotDecisionQuote, shotModelChoices, shotRemakeQuote, shotTakeOf, reviseSession, saveSettings, searchSources, startRun, uploadFile } from "./service.ts";

// Content Factory (the /content-factory screen). The checks are in service.ts: every function needs the admin role in the workspace,
// and a session's workspace is read from the session. These functions only take the signed-in user and the database.

export const listContentFactorySessions = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionsListInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listSessions(await getSql(), context.userId, data));

/** The hooks of a brand's started videos and where they repeat (portfolio). Admins of the brand's workspace only. */
export const getBrandHookHistory = createServerFn({ method: "POST" })
  .validator((input: unknown) => brandHookInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => brandHookHistory(await getSql(), context.userId, data));

/** A short-lived download link to the delivered master of a session's video. Made on request; nothing is linked before the engine delivered it. */
export const getDeliveredMasterLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => deliveredMasterLink(await getSql(), context.userId, data));

/** The approval state of a session's video, its decisions, and its publish state (not connected). Admins of the workspace only. */
export const getDeliveryApproval = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => deliveryApprovalOf(await getSql(), context.userId, data));

// Batches of videos (prompt 15). Admins of the brand's workspace only; the batch service checks each call and each item.

function brandIdOf(input: unknown): string {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return typeof body.brandId === "string" ? body.brandId.trim().slice(0, 80) : "";
}

function batchIdOf(input: unknown): string {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return typeof body.batchId === "string" ? body.batchId.trim().slice(0, 80) : "";
}

export const listContentBatches = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = brandIdOf(input);
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listBatches(await getSql(), context.userId, data));

export const getContentBatch = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const batchId = batchIdOf(input);
    if (!batchId) throw new Error("Choose a batch.");
    return { batchId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => getBatch(await getSql(), context.userId, data));

export const createContentBatch = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    return {
      brandId: brandIdOf(input),
      title: typeof body.title === "string" ? body.title.slice(0, 200) : "",
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : Number.NaN,
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds.filter((item): item is string => typeof item === "string").slice(0, 50) : [],
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createBatch(await getSql(), context.userId, data));

export const createContentVariations = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const sourceSessionId = typeof body.sourceSessionId === "string" ? body.sourceSessionId.trim().slice(0, 80) : "";
    if (!sourceSessionId) throw new Error("Choose the source draft.");
    return {
      sourceSessionId,
      count: typeof body.count === "number" ? body.count : Number.NaN,
      totalBudgetUsd: typeof body.totalBudgetUsd === "number" ? body.totalBudgetUsd : Number.NaN,
      title: typeof body.title === "string" ? body.title.slice(0, 200) : "",
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createVariations(await getSql(), context.userId, data));

export const startContentBatch = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const batchId = batchIdOf(input);
    if (!batchId) throw new Error("Choose a batch.");
    return { batchId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => startBatch(await getSql(), context.userId, data));

export const retryContentBatchItem = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 80) : "";
    const batchId = batchIdOf(input);
    if (!batchId || !sessionId) throw new Error("Choose a video in a batch.");
    return { batchId, sessionId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => retryBatchItem(await getSql(), context.userId, data));

/** Approves, or rejects with a reason, the delivered video of a session. Admins of the workspace only; the service checks the rest. */
export const decideDeliveryApproval = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    return {
      sessionId: typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 80) : "",
      decision: typeof body.decision === "string" ? body.decision : "",
      reason: typeof body.reason === "string" ? body.reason.slice(0, 1000) : "",
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!data.sessionId) throw new Error("Choose a video.");
    return recordDeliveryApproval(await getSql(), context.userId, data);
  });

/** What a brand's video runs cost: billed, estimated and held amounts, and the cost per delivered video. Admins of the brand's workspace only. */
export const getBrandEconomics = createServerFn({ method: "POST" })
  .validator((input: unknown) => brandHookInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => brandEconomics(await getSql(), context.userId, data));

export const createContentFactorySession = createServerFn({ method: "POST" })
  .validator((input: unknown) => createSessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createSession(await getSql(), context.userId, data));

/** A draft session made from one opportunity, with its brief as the first message (service.ts briefFromOpportunity). Admins only. */
export const createContentFactoryBriefFromOpportunity = createServerFn({ method: "POST" })
  .validator((input: unknown) => opportunityBriefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => briefFromOpportunity(await getSql(), context.userId, data));

/** The variations a repurpose choice resolves to on a delivered video. Nothing is stored. Admins only. */
export const previewContentFactoryRepurpose = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => repurposePreview(await getSql(), context.userId, data));

/**
 * Plans the repurposed variations of a delivered video, as child cuts. Idempotent. A variation is rendered only when the render price is
 * verified and the renderer is connected; otherwise it is recorded with its reason. Admins only.
 */
export const startContentFactoryRepurpose = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const render = productionRepurposeRenderPort(sql);
    return startRepurpose(sql, context.userId, data, render === undefined ? {} : { render });
  });

/** The latest decision on each rendered variation of a repurpose run. Admins only. */
export const listContentFactoryRepurposeReviews = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeRunInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => repurposeReviewsOf(await getSql(), context.userId, data));

/** A reviewer's approve or reject decision on one rendered variation. Records a decision only; nothing is published. Admins only. */
export const reviewContentFactoryRepurposeVariant = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeReviewInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => recordRepurposeReview(await getSql(), context.userId, data));

/** What the renderer reports for an interrupted repurposed cut. Read-only: it settles and retries nothing. Admins only. */
export const checkContentFactoryRepurposeRender = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeOutputInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return checkInterruptedRepurposeRender(sql, context.userId, data, productionRepurposeStatusPoll(sql));
  });

/** A short-lived link to a rendered variation's video. Admins only. Nothing is signed for a variation that was not rendered. */
export const getContentFactoryRepurposeOutput = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeOutputInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => repurposeOutputLink(await getSql(), context.userId, data));

/**
 * The ad sets and Pages a paused Meta ad can be created under, for the brand's saved accounts. Read only. Admins only.
 */
export const listContentFactoryPausedAdChoices = createServerFn({ method: "POST" })
  .validator((input: unknown) => pausedAdChoicesInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listPausedAdChoices(await getSql(), context.userId, data, { env: process.env }));

/**
 * Creates one PAUSED Meta ad from an uploaded variation, inside the ad set the person chose and confirmed again. Nothing is activated.
 * Admins only. A request that fails any check sends nothing and says why.
 */
export const createContentFactoryPausedAd = createServerFn({ method: "POST" })
  .validator((input: unknown) => pausedAdInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createRepurposedPausedAd(await getSql(), context.userId, data, { env: process.env }));

/**
 * Uploads one approved, rendered repurposed variation to the brand's Meta ad account and records the upload only when Meta returns its
 * video id. Admins only. A variation that is not ready, or a brand with no connected Meta account, sends nothing and says why.
 */
export const uploadContentFactoryRepurposeVariant = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeOutputInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => uploadRepurposeVariantToMeta(await getSql(), context.userId, data, { env: process.env }));

/**
 * The Facebook Pages a variation can be published to, and the Page this workspace's connection publishes as. Read only. Admins only.
 */
export const listContentFactoryRepurposeFacebookPages = createServerFn({ method: "POST" })
  .validator((input: unknown) => pausedAdChoicesInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listRepurposeFacebookPages(await getSql(), context.userId, data));

/**
 * Publishes one reviewed, rights-cleared variation to one Facebook Page, once. An admin's explicit action: it is never a side effect of
 * approval, upload, rendering or measurement. A lost reply is not sent again without a confirmation. Admins only.
 */
/**
 * Reads the published variations of one repurpose run from Facebook, and stores each real observation once. Admins only. Approval,
 * publishing and rendering never read metrics: only this action does.
 */
export const measureContentFactoryRepurposeRun = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeRunInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => measureRepurposeRun(await getSql(), context.userId, data));

export const publishContentFactoryRepurposeToFacebook = createServerFn({ method: "POST" })
  .validator((input: unknown) => repurposeOrganicInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return publishRepurposedVariantToFacebookPage(sql, context.userId, data, {
      loadMedia: (storageKey, organizationId, brandId) => loadRepurposedMedia(sql, storageKey, organizationId, brandId),
    });
  });

export const getContentFactorySession = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => getSession(await getSql(), context.userId, data));

export const postContentFactoryMessage = createServerFn({ method: "POST" })
  .validator((input: unknown) => messageInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => postMessage(await getSql(), context.userId, data));

export const saveContentFactorySettings = createServerFn({ method: "POST" })
  .validator((input: unknown) => settingsInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => saveSettings(await getSql(), context.userId, data));

export const uploadContentFactoryFile = createServerFn({ method: "POST" })
  .validator((input: unknown) => uploadInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => uploadFile(await getSql(), context.userId, data));

export const searchContentFactorySources = createServerFn({ method: "POST" })
  .validator((input: unknown) => sourceSearchInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => searchSources(await getSql(), context.userId, data));

export const attachContentFactorySource = createServerFn({ method: "POST" })
  .validator((input: unknown) => attachSourceInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => attachSource(await getSql(), context.userId, data));

export const startContentFactoryRun = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => startRun(await getSql(), context.userId, data));

export const reviseContentFactoryWithDirection = createServerFn({ method: "POST" })
  .validator((input: unknown) => reviseDirectionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => reviseWithDirection(await getSql(), context.userId, data));

export const reviseContentFactorySession = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => reviseSession(await getSql(), context.userId, data));

export const remakeContentFactoryShot = createServerFn({ method: "POST" })
  .validator((input: unknown) => remakeShotInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => remakeShot(await getSql(), context.userId, data));

/** The base64 of a reviewer's clip, decoded here so the engine receives bytes. */
function clipBytes(base64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export const quoteContentFactoryShotClip = createServerFn({ method: "POST" })
  .validator((input: unknown) => clipInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotClipQuote(await getSql(), context.userId, { sessionId: data.sessionId, shotId: data.shotId, bytes: clipBytes(data.base64) }));

export const replaceContentFactoryShotWithClip = createServerFn({ method: "POST" })
  .validator((input: unknown) => clipInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotClip(await getSql(), context.userId, { sessionId: data.sessionId, shotId: data.shotId, bytes: clipBytes(data.base64) }));

export const getContentFactoryShotModels = createServerFn({ method: "POST" })
  .validator((input: unknown) => shotRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotModelChoices(await getSql(), context.userId, { sessionId: data.sessionId, shotId: data.shotId }));

export const decideContentFactoryShot = createServerFn({ method: "POST" })
  .validator((input: unknown) => shotDecisionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotDecision(await getSql(), context.userId, data));

export const quoteContentFactoryShotDecision = createServerFn({ method: "POST" })
  .validator((input: unknown) => shotDecisionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotDecisionQuote(await getSql(), context.userId, data));

export const getContentFactoryShotTake = createServerFn({ method: "POST" })
  .validator((input: unknown) => shotRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotTakeOf(await getSql(), context.userId, data));

export const quoteContentFactoryShotRemake = createServerFn({ method: "POST" })
  .validator((input: unknown) => shotRefInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => shotRemakeQuote(await getSql(), context.userId, data));

export const readContentFactoryRun = createServerFn({ method: "POST" })
  .validator((input: unknown) => sessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => readRun(await getSql(), context.userId, data));
