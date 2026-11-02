// Choosing a cookbook for a draft run (round 3, K18a). The run's inputs are read from the session: the brief's length, the reference, the uploads,
// the budget and the length. Anything the session does not say is false, never guessed (a product kit is not read here, so it is not available).
// The choice is checked against the proposal (or the eligible list, when no selector is connected) and recorded only on a draft run.

import type { RunInputs } from "../cookbooks/eligibility.ts";
import type { ControlValue } from "../cookbooks/controls.ts";
import { libraryFor, proposeFor, type ServiceResult } from "../cookbooks/service.ts";
import { recordCookbookSelection } from "../cookbooks/run-record.ts";
import { confirmSelection, pickFromList, type SelectionRecord } from "../cookbooks/select.ts";
import type { Proposal, SelectorPort } from "../cookbooks/selector.ts";
import type { Sql } from "../learning/store.ts";
import { applyCookbook } from "./cookbook-request.ts";
import { cookbookSelectionOf } from "../cookbooks/run-record.ts";
import { readCookbookFor } from "../cookbooks/service.ts";
import { resolveCookbook } from "../cookbooks/resolve.ts";
import { referenceOf, type RequestBuild } from "./request.ts";
import type { Attachment, Message } from "./model.ts";
import { messagesOf } from "./service-sessions.ts";
import { requireDraft, sessionAccess, settingsOf, type SessionRow } from "./service-core.ts";

export type ChoiceInput = { cookbookId: string; version: number; values?: Record<string, string | number | boolean> };

/** The run's inputs as the session states them. A reference is attached when a reference video is; its cached DNA is not known here, so it is false. */
export function runInputsOf(input: { budgetUsd: number | null; messages: readonly Pick<Message, "text" | "beatRole" | "attachments">[] }): RunInputs {
  const attachments: Attachment[] = input.messages.flatMap((message) => message.attachments);
  const briefChars = input.messages.filter((message) => message.beatRole === null).reduce((total, message) => total + message.text.length, 0);
  const files = attachments.filter((item): item is Extract<Attachment, { kind: "file" }> => item.kind === "file");
  const reference = referenceOf(attachments);
  const footage = files.some((item) => item.mediaType.startsWith("video/") && item.purpose !== "reference_video");
  const voice = files.some((item) => item.mediaType.startsWith("audio/") && item.purpose !== "reference_video");
  return {
    briefChars,
    reference: { attached: reference !== null, dnaCached: false },
    productKit: false,
    uploads: { voice, footage, music: false },
    budgetUsd: input.budgetUsd,
    runKind: "normal",
  };
}

/**
 * Records the person's choice of cookbook on a draft run. A started run keeps its record. A choice must be one the library and the run's inputs
 * allow: from the proposal when a selector is connected, from the eligible list when it is not.
 */
export async function chooseCookbookFor(
  sql: Sql,
  input: { userId: string; sessionId: string; choice: ChoiceInput; port?: SelectorPort | null },
): Promise<ServiceResult<SelectionRecord>> {
  const row: SessionRow = await sessionAccess(sql, input.userId, input.sessionId);
  try {
    requireDraft(row);
  } catch {
    return { ok: false, reason: "This run has already started, so its cookbook cannot change." };
  }
  const settings = settingsOf(row);
  if (settings.maxSeconds === null) return { ok: false, reason: "Set the length before choosing a cookbook." };
  if (row.brand_id === null) return { ok: false, reason: "Choose a brand before choosing a cookbook." };
  const messages = await messagesOf(sql, row);
  const inputs = runInputsOf({ budgetUsd: settings.budgetUsd, messages });
  const lengthMs = settings.maxSeconds * 1000;
  const organizationId = row.organization_id;
  const brandId = row.brand_id;

  const library = await libraryFor(sql, { organizationId, brandId });
  const cookbooks = [...library.builtins, ...library.workspace.map((stored) => stored.cookbook)];
  const proposal: Proposal = await proposeFor(sql, { organizationId, brandId, inputs, lengthMs, port: input.port ?? null });

  let outcome: { ok: true; record: SelectionRecord } | { ok: false; reason: string };
  if (proposal.status === "proposed") {
    outcome = confirmSelection({ proposal, choice: input.choice, cookbooks, inputs });
  } else if (proposal.status === "not_connected") {
    outcome = pickFromList({ eligibleIds: proposal.eligible.map((ref) => ref.cookbookId), cookbooks, inputs, choice: input.choice });
  } else if (proposal.status === "none") {
    outcome = { ok: false, reason: proposal.reasons.join("; ") || "No cookbook can run with these inputs." };
  } else {
    outcome = { ok: false, reason: proposal.status === "failed" ? proposal.message : "The selector's answer was not used." };
  }
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const written = await recordCookbookSelection(sql, { organizationId, sessionId: input.sessionId, record: outcome.record });
  if (!written) return { ok: false, reason: "This run has already started, so its cookbook cannot change." };
  return { ok: true, value: outcome.record };
}

/**
 * The cookbooks proposed for a draft run (K18c), from the run's own inputs as the session states them. The selector's port is not connected in
 * this build, so the answer is the picker (the eligible cookbooks, with their labels). A run that has started has no choice left to make.
 */
export async function proposalForRunFor(sql: Sql, input: { userId: string; sessionId: string }): Promise<ServiceResult<Proposal>> {
  const row: SessionRow = await sessionAccess(sql, input.userId, input.sessionId);
  try {
    requireDraft(row);
  } catch {
    return { ok: false, reason: "This run has already started, so its cookbook is fixed." };
  }
  const settings = settingsOf(row);
  if (settings.maxSeconds === null) return { ok: false, reason: "Set the length before choosing a cookbook." };
  if (row.brand_id === null) return { ok: false, reason: "Choose a brand before choosing a cookbook." };
  const messages = await messagesOf(sql, row);
  const inputs = runInputsOf({ budgetUsd: settings.budgetUsd, messages });
  const proposal = await proposeFor(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    inputs,
    lengthMs: settings.maxSeconds * 1000,
    port: null,
  });
  return { ok: true, value: proposal };
}

/** What a cookbook needs and costs at the values on screen (K17). Read only: nothing is saved, and nothing is called. */
export type LiveSummary = { cookbookId: string; badge: string; requirements: string[]; estimate: { knownUsd: number; unknown: string[] } };

/** The requirements, badge and estimate of one cookbook at the person's values for this draft run (K17). The run's length is read from the session. */
export async function liveSummaryFor(
  sql: Sql,
  input: { userId: string; sessionId: string; cookbookId: string; version: number; values: Record<string, ControlValue> },
): Promise<ServiceResult<LiveSummary>> {
  const row: SessionRow = await sessionAccess(sql, input.userId, input.sessionId);
  try {
    requireDraft(row);
  } catch {
    return { ok: false, reason: "This run has already started, so its cookbook is fixed." };
  }
  const settings = settingsOf(row);
  if (settings.maxSeconds === null) return { ok: false, reason: "Set the length before choosing a cookbook." };
  if (row.brand_id === null) return { ok: false, reason: "Choose a brand before choosing a cookbook." };
  const read = await readCookbookFor(sql, { organizationId: row.organization_id, brandId: row.brand_id, cookbookId: input.cookbookId, version: input.version });
  if (!read.ok) return { ok: false, reason: read.reason };
  const resolved = resolveCookbook(read.value.cookbook, { values: input.values, lengthMs: settings.maxSeconds * 1000 });
  if (!resolved.ok) return { ok: false, reason: "These settings are not allowed.", issues: resolved.issues };
  const { cookbookId, badge, requirements, estimate } = resolved.resolved;
  return { ok: true, value: { cookbookId, badge, requirements, estimate } };
}

function incompleteWith(build: RequestBuild, problems: string[]): RequestBuild {
  const candidate = build.status === "ready" ? (build.request as unknown as Record<string, unknown>) : build.candidate;
  return { status: "incomplete", candidate, problems: [...(build.status === "incomplete" ? build.problems : []), ...problems] };
}

/**
 * Applies the cookbook a draft run recorded (K18b), if there is one: its style, its length cap and its instructions join the request, using the
 * values the person chose. With no record the request is returned as it is. A recorded cookbook that can no longer be read or resolved makes the
 * request incomplete, with the reason, rather than running without it.
 */
export async function applyRecordedCookbook(sql: Sql, row: SessionRow, build: RequestBuild): Promise<RequestBuild> {
  const record = await cookbookSelectionOf(sql, { organizationId: row.organization_id, sessionId: row.id });
  if (record === null) return build;
  const settings = settingsOf(row);
  // Without a length or a brand the request already names what is missing (its cap, its page), so there is nothing to apply yet.
  if (settings.maxSeconds === null || row.brand_id === null) return build;
  const read = await readCookbookFor(sql, { organizationId: row.organization_id, brandId: row.brand_id, cookbookId: record.cookbookId, version: record.version });
  if (!read.ok) return incompleteWith(build, ["The chosen cookbook is no longer available. Choose it again."]);
  const resolved = resolveCookbook(read.value.cookbook, { values: record.values, lengthMs: settings.maxSeconds * 1000 });
  if (!resolved.ok) return incompleteWith(build, resolved.issues);
  return applyCookbook(build, resolved.resolved);
}

