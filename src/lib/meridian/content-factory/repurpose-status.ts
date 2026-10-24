// What the renderer reports for an interrupted repurposed cut. The check is read-only. It asks the renderer about the call Meridian
// recorded for the cut, and reports the answer. It settles nothing and retries nothing: whether a call was billed, and whether a cut is
// retried, are billing decisions the engine's ledger records, not something a status reply can settle.

import { stableId } from "../../../engine/jobs/stable-id.ts";
import { sqlLedgerStore } from "../../../engine/jobs/sql-ledger-store.ts";
import type { Sql } from "../learning/store.ts";
import { sessionAccess } from "./service.ts";

/** The render's scope: its organization, its engine request, and the reservation its calls were recorded under. */
export type RenderStatusScope = { organizationId: string; requestId: string; reservationId: string };

/** Asks the renderer about one render, by the provider's own id, under the scope it was recorded in. Production: the HyperFrames adapter's poll. */
export type RenderStatusPoll = (scope: RenderStatusScope, renderId: string) => Promise<{ status: string; failureMessage?: string }>;

export type InterruptedRenderCheck =
  | { status: "not_interrupted"; reason: string }
  | { status: "no_provider_call"; reason: string }
  | { status: "no_open_call"; reason: string }
  | { status: "unreachable"; reason: string }
  | { status: "reported"; providerStatus: string; reason: string };

/** What a renderer's reported status means for the cut, in plain words. The cut stays in rendering whatever the status: none is a settlement. */
export function describeRenderStatus(report: { status: string; failureMessage?: string }): string {
  if (report.status === "completed") {
    return "The renderer reports this render completed. Its video is not stored, so the cut stays in rendering. Storing a completed render is not connected in this release.";
  }
  if (report.status === "failed") {
    const detail = report.failureMessage ? `: ${report.failureMessage}` : "";
    return `The renderer reports this render failed${detail}. Whether it was billed is not confirmed by this check, so the cut stays in rendering until its call is settled.`;
  }
  return `The renderer reports this render as ${report.status}. The cut stays in rendering.`;
}

/**
 * Checks an interrupted repurposed cut with its renderer. Admins only. Only a cut recorded as rendering is checked, and only the calls
 * the ledger recorded for it, through the renderer's own id.
 */
export async function checkInterruptedRepurposeRender(
  sql: Sql,
  userId: string,
  input: { sessionId: string; runId: string; variantKey: string },
  poll: RenderStatusPoll,
): Promise<InterruptedRenderCheck> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const found = await sql<{ status: string }>`
    select v.status from content_factory_repurpose_variants v
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    where v.organization_id = ${row.organization_id} and r.session_id = ${row.id} and v.run_id = ${input.runId} and v.variant_key = ${input.variantKey}
    limit 1
  `;
  if (found[0]?.status !== "rendering") {
    return { status: "not_interrupted", reason: "This variation is not waiting on the renderer, so there is nothing to check." };
  }
  if (row.engine_request_id === null) {
    return { status: "no_provider_call", reason: "This session has no engine request, so no renderer call was recorded for this cut." };
  }
  const reservationId = stableId("res_", `repurpose|${row.engine_request_id}|${input.variantKey}`);
  const entries = await sqlLedgerStore(sql, row.organization_id).listEntries(reservationId);
  if (entries.length === 0) {
    return { status: "no_provider_call", reason: "No call to the renderer is recorded for this cut, so the renderer has not been asked for it." };
  }
  const open = entries.filter((entry) => entry.settlement === undefined && entry.providerRef !== null);
  if (open.length === 0) {
    return { status: "no_open_call", reason: "Every recorded call for this cut is settled, so there is no renderer call to check." };
  }
  const renderId = open[open.length - 1]!.providerRef!;
  try {
    const report = await poll({ organizationId: row.organization_id, requestId: row.engine_request_id, reservationId }, renderId);
    return { status: "reported", providerStatus: report.status, reason: describeRenderStatus(report) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "the renderer did not answer";
    return { status: "unreachable", reason: `The renderer could not be asked: ${message}. Nothing has changed.` };
  }
}
