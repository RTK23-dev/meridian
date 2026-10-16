import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { newId } from "../../../engine/contracts/index.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { engineInboxItems } from "./engine-items.ts";

test("the video engine's open review items of a brand are listed in the Reviews inbox, with the engine's reason, and no other brand's", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "reviews-engine");
  const other = await studioTenant(sql, "reviews-engine-other");
  const requestId = newId("req_");
  await sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, current_stage, state)
    values (${requestId}, ${tenant.organizationId}, ${tenant.brandId}, 'ugc-demo-hook', 'normal', 'paused', 'check_take', '{}')
  `;
  await sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
    values (${randomUUID()}, ${tenant.organizationId}, ${requestId}, 'escalation', 'open', 'shot_fixture',
      'check_take failed its take gate after 2 redos', '{"stage":"check_take"}')
  `;
  await sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail, resolved_at)
    values (${randomUUID()}, ${tenant.organizationId}, ${requestId}, 'dead_letter', 'resolved', 'shot_fixture', 'resolved earlier', '{}', now())
  `;

  const items = await engineInboxItems(sql, tenant.organizationId, tenant.brandId);
  assert.equal(items.length, 1, "the resolved item is not in the inbox");
  assert.equal(items[0]?.label, "Escalated by the video engine at check_take");
  assert.equal(items[0]?.reason, "check_take failed its take gate after 2 redos");
  assert.equal(items[0]?.requestId, requestId);
  assert.equal(items[0]?.kind, "escalation");

  assert.deepEqual(await engineInboxItems(sql, other.organizationId, other.brandId), [], "another brand lists none");
  assert.deepEqual(await engineInboxItems(sql, other.organizationId, tenant.brandId), [], "a brand is read only through its own workspace");
});
