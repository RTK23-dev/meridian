/**
 * The checks and the reads and writes behind the Content Factory server functions (actions.ts). Everything that decides who may see or
 * change what is here, so the tests run it on PGlite without the server runtime.
 *
 * - Roles (AGENTS.md rule 2). Every read and every write needs the admin role in the workspace (access.ts hasRole). The role is the one
 *   the database holds for the caller, never one the client sends.
 * - Tenancy. A workspace read needs a membership in that workspace. A session is read in the workspace it belongs to, and the server
 *   looks that workspace up from the session id: a client never names the workspace of a session. A caller who is not a member gets the
 *   same refusal as for an unknown session, so a session id reveals nothing about other workspaces. A brand must be a brand of the
 *   session's workspace.
 * - One video at a time. While a request is running, the session takes no more messages, files or settings. When that request is
 *   delivered or has failed, a revision reopens the session. The earlier request stays stored, and the next video gets its own id.
 * - The engine is reached only through src/engine/api: start, requestProblems (through request.ts), readiness and the request feed.
 */
// The Content Factory service. Its functions live in service-*.ts, grouped by responsibility (coding loop, T6). Callers import
// from this path, which re-exports every public name.

export { WORKSPACE_REFUSAL, SESSION_REFUSAL, ADMIN_REFUSAL, BRAND_REFUSAL, STARTED_REFUSAL, MESSAGE_REFUSAL, REFERENCE_NOTE, requireWorkspaceAdmin, sessionAccess, todayIso } from "./service-core.ts";
export type { ContentFactoryPorts } from "./service-core.ts";
export { BRAND_SESSION_LIST_LIMIT, listSessions, createSession, briefFromOpportunity, getSession, postMessage, saveSettings, uploadFile, searchSources, attachSource } from "./service-sessions.ts";
export type { SettingsInput, UploadInput, UploadOutcome } from "./service-sessions.ts";
export { startRun, reviseWithDirection, reviseSession, readRun } from "./service-run.ts";
export type { StartOutcome, ReviseOutcome, RunView } from "./service-run.ts";
export { brandHookHistory, brandEconomics, deliveredMasterLink, storedFilesOf, rightsRecordsOf, deliveryApprovalOf, recordDeliveryApproval } from "./service-delivery.ts";
export type { DeliveredLink, DeliveryApproval } from "./service-delivery.ts";
export { remakeShot, shotTakeOf, shotClip, shotClipQuote, shotModelChoices, shotRemakeQuote, shotDecision, shotDecisionQuote } from "./service-shots.ts";
export type { RemakeOutcome } from "./service-shots.ts";
