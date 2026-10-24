// Repurposing a delivered Content Factory video (the repurpose core in src/engine/repurpose/, contract v11). The master cut is read from the
// engine request that delivered the video. Each variation is a child cut of that master, recorded as its own EDL artifact under the same
// request, parented on the master's. Rendering uses the engine's cloud renderer only through a port the caller supplies. Nothing is funded or
// rendered without a verified render price, and nothing is recorded as rendered unless the renderer returned a video.

import { createHash, randomUUID } from "node:crypto";
import { engineRequestStatus } from "../../../engine/api/index.ts";
import { edlSchema, type EditDecisionList } from "../../../engine/contracts/index.ts";
import { readArtifact, writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { priceFor } from "../../../engine/config/prices.ts";
import { repurposedEdl } from "../../../engine/repurpose/child.ts";
import { repurposeSettingsSchema, resolveRepurpose, type RepurposeOutcome } from "../../../engine/repurpose/resolve.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { sessionAccess } from "./service.ts";

/** The reason a variation is not rendered while the HyperFrames cloud render price is not in the price table. Stated, never estimated. */
export const RENDER_PRICE_NOT_VERIFIED =
  "The HyperFrames cloud render price is not verified in the price table, so this variation is not rendered and no cost is recorded.";
export const RENDERER_NOT_CONNECTED = "The cloud renderer is not connected for repurposed variations, so this variation is not rendered.";

/**
 * "rendering" is set before the renderer is called and cleared by its result. A variation found in it is never sent again: if the process
 * stopped during the call, the renderer may have billed it, so it is shown as interrupted rather than retried.
 */
export type RepurposeVariationStatus = "planned" | "not_priced" | "not_connected" | "rendering" | "rendered" | "failed";

export type RepurposeVariationRow = {
  key: string;
  ordinal: number;
  status: RepurposeVariationStatus;
  reason: string;
  childEdlId: string;
  childArtifactId: string;
  renderedArtifactId: string | null;
  treatments: Array<{ category: string; optionId: string; label: string }>;
};

export type RepurposeRunView = {
  runId: string;
  created: boolean;
  masterEdlId: string;
  variations: RepurposeVariationRow[];
};

/** The render price of a video of this length, in USD, from the price table. Undefined while the table has no verified number. */
export function renderPriceUsdOf(durationMs: number): number | undefined {
  const price = priceFor("render_hyperframes_cloud");
  if (price.usd === null) return undefined;
  return price.usd * (durationMs / 60_000);
}

/**
 * The renderer for one child cut. It stores the finished video in the engine and returns its artifact id, or the reason it failed. It owns
 * the budget reservation for the call. Absent, rendering is not connected and nothing is sent.
 */
export type RepurposeRenderPort = (child: {
  organizationId: string;
  engineRequestId: string;
  variationKey: string;
  /** The child cut's artifact id, which the render reads its EDL from. */
  childArtifactId: string;
  edl: EditDecisionList;
  estimateUsd: number;
}) => Promise<{ status: "rendered"; artifactId: string } | { status: "failed"; reason: string }>;

export type RepurposePorts = {
  /** The render price for a video of this length, or undefined. Default: the price table. */
  renderPriceUsd?: (durationMs: number) => number | undefined;
  render?: RepurposeRenderPort;
};

/** The master cut of a delivered engine request, read through its contract. */
async function masterOf(sql: Sql, organizationId: string, requestId: string): Promise<{ edl: EditDecisionList; artifactId: string }> {
  const rows = await sql<{ state: string }>`
    select state from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const state = JSON.parse(rows[0]?.state ?? "{}") as { masterEdlId?: string | null; artifacts?: Record<string, string> };
  if (!state.masterEdlId) throw new Error("This video has no master cut to repurpose.");
  const artifactId = state.artifacts?.[`edl:${state.masterEdlId}`];
  if (!artifactId) throw new Error("The master cut of this video is not stored, so it cannot be repurposed.");
  const stored = await readArtifact(sql, { organizationId, artifactId });
  return { edl: edlSchema.parse(stored.envelope.body), artifactId };
}

/** The engine request of a session that the engine has delivered. Anything else is refused. */
async function deliveredRequestOf(sql: Sql, organizationId: string, engineRequestId: string | null): Promise<string> {
  if (engineRequestId === null) throw new Error("This session has no video yet, so there is nothing to repurpose.");
  const status = await engineRequestStatus(sql, organizationId, engineRequestId);
  if (status?.status !== "delivered") throw new Error("The video is not delivered yet, so it cannot be repurposed.");
  return engineRequestId;
}

/** The settings and the master they were applied to. The digest is the run's identity: the same settings on the same master are one run. */
function digestOf(settings: unknown, masterEdlId: string): string {
  return createHash("sha256").update(JSON.stringify({ settings, masterEdlId })).digest("hex");
}

/** The variations the settings resolve to on this master. Pure with respect to the database; it reads the master and nothing else. */
export async function repurposePreview(sql: Sql, userId: string, input: { sessionId: string; settings: unknown }): Promise<RepurposeOutcome & { masterEdlId: string | null }> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const requestId = await deliveredRequestOf(sql, row.organization_id, row.engine_request_id);
  const master = await masterOf(sql, row.organization_id, requestId);
  const outcome = resolveRepurpose({ settings: input.settings, sourceEdlId: master.edl.edlId, requestId });
  return { ...outcome, masterEdlId: master.edl.edlId };
}

/**
 * Makes the repurposed variations of a delivered video. Idempotent: the same settings on the same master return the same run, and a variation
 * that was rendered is never rendered again. A variation that was not priced, not connected or failed is tried again on the next call, with
 * the ports then given. A refusal changes nothing.
 */
export async function startRepurpose(sql: Sql, userId: string, input: { sessionId: string; settings: unknown }, ports: RepurposePorts = {}): Promise<RepurposeRunView> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const requestId = await deliveredRequestOf(sql, row.organization_id, row.engine_request_id);
  const master = await masterOf(sql, row.organization_id, requestId);
  const settings = repurposeSettingsSchema.safeParse(input.settings);
  if (!settings.success) throw new Error(settings.error.issues.map((issue) => issue.message).join(" "));
  const outcome = resolveRepurpose({ settings: settings.data, sourceEdlId: master.edl.edlId, requestId });
  if (outcome.status === "off") throw new Error("Turn repurposing on to make variations.");
  if (outcome.status === "refused") throw new Error(outcome.reasons.join(" "));

  const digest = digestOf(settings.data, master.edl.edlId);
  const organizationId = row.organization_id;
  const session = row.id;
  const { runId, created } = await withTransaction(sql, async (tx) => {
    const inserted = await tx<{ id: string }>`
      insert into content_factory_repurpose_runs (id, organization_id, brand_id, session_id, engine_request_id, master_edl_id, settings_digest, settings, created_by)
      values (${randomUUID()}, ${organizationId}, ${row.brand_id}, ${session}, ${requestId}, ${master.edl.edlId}, ${digest}, ${JSON.stringify(settings.data)}, ${userId})
      on conflict (organization_id, session_id, master_edl_id, settings_digest) do nothing
      returning id
    `;
    const existing = inserted[0]
      ? inserted[0].id
      : (
          await tx<{ id: string }>`
            select id from content_factory_repurpose_runs
            where organization_id = ${organizationId} and session_id = ${session} and master_edl_id = ${master.edl.edlId} and settings_digest = ${digest}
            for update
          `
        )[0]!.id;
    if (inserted[0]) {
      // A new run plans each variation once: its child cut is stored under the master's request, parented on the master's EDL.
      for (const variation of outcome.variations) {
        const child = repurposedEdl(master.edl, variation.visual, variation.key);
        const stored = await writeArtifact(tx, {
          organizationId,
          requestId,
          stage: "repurpose",
          type: "edl",
          body: child,
          parentIds: [master.artifactId],
          createdAt: new Date().toISOString(),
        });
        await tx`
          insert into content_factory_repurpose_variants
            (id, organization_id, run_id, ordinal, variant_key, treatments, visual, child_edl_id, child_artifact_id, status, reason)
          values (${randomUUID()}, ${organizationId}, ${existing}, ${variation.index}, ${variation.key}, ${JSON.stringify(variation.treatments)},
            ${JSON.stringify(variation.visual)}, ${child.edlId}, ${stored.artifactId}, 'planned', '')
        `;
      }
    }
    return { runId: existing, created: inserted[0] !== undefined };
  });

  // Rendering is outside the planning transaction: a renderer makes a network call and reserves its own budget.
  const priceUsd = ports.renderPriceUsd ?? renderPriceUsdOf;
  const estimateUsd = priceUsd(master.edl.durationMs);
  // Only a variation that may be claimed is read: a rendered one, or one a renderer is still working on or was interrupted during, is left alone.
  const pending = await sql<{ variant_key: string; child_artifact_id: string }>`
    select variant_key, child_artifact_id from content_factory_repurpose_variants
    where run_id = ${runId} and organization_id = ${organizationId} and status in ('planned', 'not_priced', 'not_connected', 'failed')
    order by ordinal asc
  `;
  for (const variant of pending) {
    if (estimateUsd === undefined) {
      await setStatus(sql, runId, variant.variant_key, "not_priced", RENDER_PRICE_NOT_VERIFIED, null);
      continue;
    }
    if (ports.render === undefined) {
      await setStatus(sql, runId, variant.variant_key, "not_connected", RENDERER_NOT_CONNECTED, null);
      continue;
    }
    // Claim the variation before the renderer is called. A concurrent start that already claimed it leaves it to that call.
    const claimed = await sql<{ id: string }>`
      update content_factory_repurpose_variants set status = 'rendering', reason = '', updated_at = now()
      where run_id = ${runId} and variant_key = ${variant.variant_key} and status in ('planned', 'not_priced', 'not_connected', 'failed')
      returning id
    `;
    if (claimed.length === 0) continue;
    const edl = await childEdlOf(sql, organizationId, variant.child_artifact_id);
    const result = await ports.render({ organizationId, engineRequestId: requestId, variationKey: variant.variant_key, childArtifactId: variant.child_artifact_id, edl, estimateUsd });
    if (result.status === "rendered") await setStatus(sql, runId, variant.variant_key, "rendered", "", result.artifactId);
    else await setStatus(sql, runId, variant.variant_key, "failed", result.reason, null);
  }

  const variations = await sql<{ variant_key: string; ordinal: number; status: RepurposeVariationStatus; reason: string; child_edl_id: string; child_artifact_id: string; rendered_artifact_id: string | null; treatments: string }>`
    select variant_key, ordinal, status, reason, child_edl_id, child_artifact_id, rendered_artifact_id, treatments
    from content_factory_repurpose_variants where run_id = ${runId} and organization_id = ${organizationId} order by ordinal asc
  `;
  return {
    runId,
    created,
    masterEdlId: master.edl.edlId,
    variations: variations.map((item) => ({
      key: item.variant_key,
      ordinal: item.ordinal,
      status: item.status,
      reason: item.reason,
      childEdlId: item.child_edl_id,
      childArtifactId: item.child_artifact_id,
      renderedArtifactId: item.rendered_artifact_id,
      treatments: JSON.parse(item.treatments) as RepurposeVariationRow["treatments"],
    })),
  };
}

async function setStatus(sql: Sql, runId: string, variantKey: string, status: RepurposeVariationStatus, reason: string, renderedArtifactId: string | null): Promise<void> {
  await sql`
    update content_factory_repurpose_variants
    set status = ${status}, reason = ${reason}, rendered_artifact_id = ${renderedArtifactId}, updated_at = now()
    where run_id = ${runId} and variant_key = ${variantKey}
  `;
}

async function childEdlOf(sql: Sql, organizationId: string, artifactId: string): Promise<EditDecisionList> {
  const stored = await readArtifact(sql, { organizationId, artifactId });
  return edlSchema.parse(stored.envelope.body);
}
