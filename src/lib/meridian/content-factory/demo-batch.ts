// Demo mode: a batch of fixture videos that works with no key, no provider and no cost, so the whole review and export path can be tried.
// Every row is marked demo and titled DEMO (fixture). The two "delivered" videos have an engine request in a delivered state and no video file:
// they are fixtures, never a provider result. Real reports leave them out. Admins of the brand's workspace only. Making it again returns the
// demo batch the brand already has.

import { randomUUID } from "node:crypto";
import { advance } from "../../../engine/jobs/orchestrator.ts";
import { requireBrand } from "../brand-membership.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { getBatch, type BatchSummary } from "./batch-service.ts";

export const DEMO_FORMAT_ID = "fmt_demo";
export const DEMO_TITLE_PREFIX = "DEMO (fixture)";

const VIDEOS = [
  { title: `${DEMO_TITLE_PREFIX} video A`, delivered: true },
  { title: `${DEMO_TITLE_PREFIX} video B`, delivered: true },
  { title: `${DEMO_TITLE_PREFIX} video C (draft)`, delivered: false },
] as const;

function deliveredState(organizationId: string, requestId: string, manifestId: string): string {
  const started = advance(null, { type: "start", organizationId, requestId, priority: "normal", cachedDna: false, variantCount: 0, requestArtifactId: "art_demo" });
  const state = JSON.parse(JSON.stringify(started.state)) as { manifestId: string | null; nodes: { intake: Record<string, unknown> } };
  state.manifestId = manifestId;
  state.nodes.intake = { ...state.nodes.intake, status: "passed" };
  return JSON.stringify(state);
}

export async function createDemoBatch(sql: Sql, userId: string, input: { brandId: string }): Promise<BatchSummary> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const [existing] = await sql<{ id: string }>`
    select id from content_factory_batches where organization_id = ${access.organizationId} and brand_id = ${input.brandId} and demo order by created_at desc limit 1
  `;
  if (existing) return getBatch(sql, userId, { batchId: existing.id });
  const batchId = randomUUID();
  await withTransaction(sql, async (tx) => {
    await tx`
      insert into content_factory_batches (id, organization_id, brand_id, title, budget_usd, created_by, demo)
      values (${batchId}, ${access.organizationId}, ${input.brandId}, ${`${DEMO_TITLE_PREFIX} batch`}, 6, ${userId}, true)
    `;
    for (const [position, video] of VIDEOS.entries()) {
      const sessionId = randomUUID();
      if (video.delivered) {
        const requestId = `req_demo_${randomUUID()}`;
        await tx`
          insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state, current_stage)
          values (${requestId}, ${access.organizationId}, ${input.brandId}, ${DEMO_FORMAT_ID}, 'normal', 'delivered', ${deliveredState(access.organizationId, requestId, `man_demo_${randomUUID()}`)}, 'deliver')
        `;
        await tx`
          insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at, budget_usd, demo)
          values (${sessionId}, ${access.organizationId}, ${input.brandId}, ${userId}, ${video.title}, 'started', ${requestId}, now(), 2, true)
        `;
      } else {
        await tx`
          insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, budget_usd, demo)
          values (${sessionId}, ${access.organizationId}, ${input.brandId}, ${userId}, ${video.title}, 'draft', 2, true)
        `;
      }
      await tx`
        insert into content_factory_batch_items (id, organization_id, batch_id, session_id, position)
        values (${randomUUID()}, ${access.organizationId}, ${batchId}, ${sessionId}, ${position})
      `;
    }
    await tx`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${randomUUID()}, ${access.organizationId}, ${input.brandId}, ${userId}, 'content_factory.demo_batch_created', 'content_factory_batch', ${batchId}, ${JSON.stringify({ demo: "true" })})
    `;
  });
  return getBatch(sql, userId, { batchId });
}
