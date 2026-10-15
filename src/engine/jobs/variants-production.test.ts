// The variants stage's production ports (Video Engine Bible 6.13, 14.1). The writer's route is read through the gateway and its key comes from
// the credential source, so a workspace without a key sees NOT_CONNECTED before any call. The voice is not wired in production, so a variant
// that needs a voice is NOT_CONNECTED too. The product kit of a SKU is read from the workspace's own kit rows. Recorded and local only.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gatewayFor } from "../claude/test/helpers.ts";
import type { ProductKit } from "../contracts/index.ts";
import { productKitFixture } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import { productionVariantPorts } from "./production-ports.ts";
import { productKitBySku, writeKit } from "./kit-store.ts";

const WS = "ws_variants_production";
const OTHER_WS = "ws_variants_production_other";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await seedWorkspace(db.sql, OTHER_WS, "brand_other");
});

after(async () => {
  await db.close();
});

function portsWith(keys: Record<string, string>) {
  const { gateway, requests } = gatewayFor([], { keys });
  const ports = productionVariantPorts({
    sql: db.sql,
    gateway,
    roles: () => {
      throw new Error("no role call is expected in this test");
    },
    workspaceBudget: notConnectedWorkspaceBudget,
    now: () => "2026-10-13T09:30:00.000Z",
  });
  return { ports, requests };
}

test("without an OpenRouter key, the writer is NOT_CONNECTED with its reason and the voice is NOT_CONNECTED, and no call is made", async () => {
  const { ports, requests } = portsWith({});
  const generation = ports.generation;
  assert.ok(generation);
  if (!generation) return;
  const connection = await generation.connection({ organizationId: WS });
  assert.ok(connection.writer?.startsWith("NOT_CONNECTED:"), `the writer reason is NOT_CONNECTED: ${connection.writer}`);
  assert.ok(connection.voice?.startsWith("NOT_CONNECTED:"), `the voice reason is NOT_CONNECTED: ${connection.voice}`);
  assert.match(connection.voice ?? "", /speech route/);
  assert.equal(requests.length, 0, "the connection check makes no call");
});

test("with the workspace's OpenRouter key, the writer is connected, and the voice stays NOT_CONNECTED (no voice port in production)", async () => {
  const { ports, requests } = portsWith({ openrouter: "sk-or-test" });
  const generation = ports.generation;
  assert.ok(generation);
  if (!generation) return;
  const connection = await generation.connection({ organizationId: WS });
  assert.equal(connection.writer, null, "the writer's route has its key");
  assert.ok(connection.voice?.startsWith("NOT_CONNECTED:"));
  assert.equal(generation.voice, undefined, "no voice port is built in production");
  assert.equal(generation.speak, undefined, "no speaker is built in production");
  assert.equal(requests.length, 0, "the connection check makes no call");
});

test("the workspace month budget is not connected in production until Settings sets it: the month reads as null", async () => {
  const { ports } = portsWith({});
  const budget = ports.workspaceMonthBudget;
  assert.ok(budget);
  if (!budget) return;
  assert.equal(await budget({ organizationId: WS, requestId: "req_x", now: "2026-10-13T09:30:00.000Z" }), null);
});

test("the product kit of a SKU is read from the workspace's own rows, the highest version of it, and never another workspace's", async () => {
  const kit = productKitFixture as ProductKit;
  await writeKit(db.sql, { organizationId: WS, kind: "product", body: kit });
  await writeKit(db.sql, { organizationId: WS, kind: "product", body: { ...kit, version: 2, name: "Fixture Blender 2" } });
  await writeKit(db.sql, { organizationId: OTHER_WS, kind: "product", body: { ...kit, productKitId: "pk_other", sku: "SKU-OTHER", name: "Other" } });

  const found = await productKitBySku(db.sql, { organizationId: WS, sku: kit.sku });
  assert.equal(found?.version, 2, "the highest version wins");
  assert.equal(found?.name, "Fixture Blender 2");
  assert.equal(await productKitBySku(db.sql, { organizationId: WS, sku: "SKU-NOPE" }), undefined);
  assert.equal(await productKitBySku(db.sql, { organizationId: OTHER_WS, sku: kit.sku }), undefined, "another workspace's kit is not read");
  assert.equal((await productKitBySku(db.sql, { organizationId: OTHER_WS, sku: "SKU-OTHER" }))?.name, "Other");
});
