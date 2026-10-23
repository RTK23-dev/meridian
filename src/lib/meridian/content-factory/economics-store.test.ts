// A brand's run economics from the engine's real tables (PGlite, every migration). The billed amount comes only from settled ledger lines;
// a held call is counted with its estimate; another brand's and another workspace's runs never count; and a viewer is refused.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { brandEconomics } from "./service.ts";

const WS = "org_economics";
const OTHER_WS = "org_economics_other";
const BRAND = "brand_economics";
const ADMIN = "user_economics_admin";
const VIEWER = "user_economics_viewer";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, "brand_economics_other");
  for (const [id, role] of [[ADMIN, "admin"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  await db.sql`insert into brands (id, organization_id, name, sells, created_by) values ('brand_economics_second', ${WS}, 'Second brand', 'Other', ${ADMIN})`;
  // Run A: delivered, with a billed call and a held call. Run B: not delivered, with a billed call. Run C: this workspace's second brand.
  await run("req_a", WS, BRAND, "delivered");
  await run("req_b", WS, BRAND, "running");
  await run("req_c", WS, "brand_economics_second", "delivered");
  await run("req_other_ws", OTHER_WS, "brand_economics_other", "delivered");
  await line("req_a", WS, "shot", 1, 0.8, "billed", "key_a_billed");
  await line("req_a", WS, "voice", 0.5, null, null, "key_a_held");
  await line("req_b", WS, "shot", 2, 1.7, "billed", "key_b_billed");
  await line("req_c", WS, "shot", 3, 2.5, "billed", "key_c_billed");
  await line("req_other_ws", OTHER_WS, "shot", 9, 9, "billed", "key_other_ws");
});

after(async () => {
  await db.close();
});

async function run(id: string, organizationId: string, brandId: string, status: string): Promise<void> {
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${id}, ${organizationId}, ${brandId}, 'fmt_economics', 'normal', ${status === "delivered" ? "delivered" : "running"}, '{}')
  `;
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${`res_${id}`}, ${organizationId}, ${id}, 'cap', 'reserved', '[]', 1, 0, 1, now())
  `;
}

async function line(requestId: string, organizationId: string, stage: string, estimate: number, actual: number | null, settlement: string | null, key: string): Promise<void> {
  await db.sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, idempotency_key, at)
    values (${`led_${key}`}, ${organizationId}, ${requestId}, ${`res_${requestId}`}, ${stage}, 'openrouter', 'model-x', ${estimate}, ${estimate}, ${actual}, ${settlement}, ${key}, now())
  `;
}

test("a brand's billed amount, estimates and held calls come from its own settled ledger lines", async () => {
  const economics = await brandEconomics(db.sql, ADMIN, { organizationId: WS, brandId: BRAND });
  assert.equal(economics.runs, 2, "this brand has two runs: the other brand's and the other workspace's are not counted");
  assert.equal(economics.delivered, 1);
  assert.equal(economics.billedUsd, 2.5, "0.8 and 1.7 are billed; the held call adds nothing");
  assert.equal(economics.estimatedUsd, 3.5, "every call of this brand's runs, billed or held");
  assert.equal(economics.heldCalls, 1);
  assert.equal(economics.heldEstimateUsd, 0.5);
});

test("the cost per delivered video is not final while the delivered run has a held call", async () => {
  const economics = await brandEconomics(db.sql, ADMIN, { organizationId: WS, brandId: BRAND });
  assert.equal(economics.costPerDeliveredUsd, 0.8, "the billed amount of the delivered run, over one delivered run");
  assert.equal(economics.costPerDeliveredFinal, false, "the held voice call may still change the figure");
});

test("a viewer of the workspace is refused, and so is a brand from another workspace", async () => {
  await assert.rejects(brandEconomics(db.sql, VIEWER, { organizationId: WS, brandId: BRAND }), /admin/i);
  await assert.rejects(brandEconomics(db.sql, ADMIN, { organizationId: WS, brandId: "brand_economics_other" }), /not in this workspace/);
});
