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
  remakeShotInput,
  clipInput,
  reviseDirectionInput,
  shotDecisionInput,
  shotRefInput,
  sessionInput,
  settingsInput,
  sourceSearchInput,
  uploadInput,
  workspaceInput,
} from "./input.ts";
import { createBatch, getBatch, listBatches, retryBatchItem, startBatch } from "./batch-service.ts";
import { repurposePreview, startRepurpose } from "./repurpose.ts";
import { productionRepurposeRenderPort } from "./repurpose-production.ts";
import { attachSource, brandEconomics, brandHookHistory, briefFromOpportunity, createSession, deliveredMasterLink, deliveryApprovalOf, getSession, listSessions, postMessage, readRun, recordDeliveryApproval, remakeShot, reviseWithDirection, shotClip, shotClipQuote, shotDecision, shotDecisionQuote, shotModelChoices, shotRemakeQuote, shotTakeOf, reviseSession, saveSettings, searchSources, startRun, uploadFile } from "./service.ts";

// Content Factory (the /content-factory screen). The checks are in service.ts: every function needs the admin role in the workspace,
// and a session's workspace is read from the session. These functions only take the signed-in user and the database.

export const listContentFactorySessions = createServerFn({ method: "POST" })
  .validator((input: unknown) => workspaceInput(input))
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
