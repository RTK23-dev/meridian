import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  attachSourceInput,
  createSessionInput,
  messageInput,
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
import { attachSource, createSession, getSession, listSessions, postMessage, readRun, remakeShot, reviseWithDirection, shotClip, shotClipQuote, shotDecision, shotDecisionQuote, shotModelChoices, shotRemakeQuote, shotTakeOf, reviseSession, saveSettings, searchSources, startRun, uploadFile } from "./service.ts";

// Content Factory (the /content-factory screen). The checks are in service.ts: every function needs the admin role in the workspace,
// and a session's workspace is read from the session. These functions only take the signed-in user and the database.

export const listContentFactorySessions = createServerFn({ method: "POST" })
  .validator((input: unknown) => workspaceInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => listSessions(await getSql(), context.userId, data));

export const createContentFactorySession = createServerFn({ method: "POST" })
  .validator((input: unknown) => createSessionInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => createSession(await getSql(), context.userId, data));

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
