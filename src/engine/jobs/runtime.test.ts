import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { gatewayWith, recordedTransport } from "./test/harness.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import { createEngineRuntime, productionComposition, productionEngineRuntime, produceShotPortsOf, type EngineComposition } from "./runtime.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import type { RenderPorts } from "./handlers/render.ts";
import { EngineError } from "../contracts/index.ts";
import { memoryMediaStore } from "../assets/adapter.ts";
import { createGateway } from "../gateway/gateway.ts";
import { engineMediaLinkSigner } from "../../lib/meridian/storage/engine-media-link.ts";
import { fakeMedia, fakeObjects, keySource } from "./test/harness.ts";

/** Ports that are only registered, never called: the runtime builds handlers and does not run them. */
function fakeRenderPorts(): RenderPorts {
  return {
    loadStyleKit: async () => undefined,
    renderEstimateUsd: async () => undefined,
    hyperframes: () => {
      throw new Error("not called in this test");
    },
    now: () => "2026-10-15T14:00:00.000Z",
  };
}

function fakePostRenderPorts(): PostRenderPorts {
  return {
    gateway: gatewayWith(recordedTransport({}).transport),
    media: {} as PostRenderPorts["media"],
    objects: {} as PostRenderPorts["objects"],
    now: () => "2026-10-15T14:00:00.000Z",
  };
}

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, "ws_runtime", "brand_runtime");
});

after(async () => {
  await db.close();
});

function composition(overrides: Partial<EngineComposition> = {}): EngineComposition {
  return {
    sql: db.sql,
    gateway: gatewayWith(recordedTransport({}).transport),
    workspaceBudget: notConnectedWorkspaceBudget,
    now: () => "2026-10-15T14:00:00.000Z",
    ...overrides,
  };
}

test("the stages that need no provider are registered on the kit store and the engine tables", () => {
  const runtime = createEngineRuntime(composition());
  for (const stage of ["pre_render_gate", "compose", "variants", "deliver", "intake", "plan", "estimate_reserve", "edit"] as const) {
    assert.ok(runtime.handlers[stage], `${stage} has a handler`);
  }
});

test("render and post-render review stay not_implemented without their ports (fail closed, never a success)", () => {
  const runtime = createEngineRuntime(composition());
  assert.equal(runtime.handlers.render, undefined);
  assert.equal(runtime.handlers.post_render_review, undefined);
  assert.equal(runtime.handlers.produce_shot, undefined, "produce_shot needs the shot ports");
});

test("the render stage and the post-render review are registered when their ports are given", () => {
  const runtime = createEngineRuntime(composition({ render: fakeRenderPorts(), postRender: fakePostRenderPorts() }));
  assert.ok(runtime.handlers.render, "render has a handler");
  assert.ok(runtime.handlers.post_render_review, "post_render_review has a handler");
});

test("the composition's style kit reader is the one compose and pre-render use", async () => {
  let reads = 0;
  const runtime = createEngineRuntime(
    composition({
      styleKit: async () => {
        reads += 1;
        return undefined;
      },
    }),
  );
  assert.ok(runtime.handlers.compose && runtime.handlers.pre_render_gate);
  assert.equal(reads, 0, "no kit is read when the runtime is built");
});

const PROD_ORG = "ws_runtime";
const PROD_KIT = `kits/${PROD_ORG}/brand_runtime/character/char_1/sheet-1.png`;

/** The production signer with its secret and origin given (the server's values are read only in production). */
function prodSigner(secret: string | null = "z".repeat(40)) {
  return engineMediaLinkSigner({ secret: () => secret, origin: () => "https://meridian.example.com", nowSeconds: () => 1_800_000_000 });
}

test("production wiring gives the chain a providerUrl that links a kit image of the organization through Meridian's signer", async () => {
  const composition = productionComposition(db.sql, { gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: prodSigner() });
  const providerUrl = composition.providerUrl;
  assert.ok(providerUrl, "the production composition carries the chain's providerUrl");
  const link = new URL(await providerUrl({ organizationId: PROD_ORG, uri: `store://${PROD_KIT}` }));
  assert.equal(link.protocol, "https:");
  assert.equal(link.searchParams.get("key"), PROD_KIT);
  assert.equal(link.searchParams.get("org"), PROD_ORG);
});

test("production wiring: a chain provider with no base URL makes the chain's providerUrl NOT_CONNECTED, with its reason", async () => {
  const gateway = createGateway({
    transport: recordedTransport({}).transport,
    credentials: keySource({ openrouter: "sk-or-test" }),
    providers: { openrouter: { baseUrl: null } },
  });
  const providerUrl = productionComposition(db.sql, { gateway, mediaLinks: prodSigner() }).providerUrl;
  assert.ok(providerUrl);
  await assert.rejects(
    () => providerUrl({ organizationId: PROD_ORG, uri: `store://${PROD_KIT}` }),
    (error: unknown) =>
      error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED: ") && error.message.includes("openrouter"),
  );
});

test("production wiring: without MEDIA_LINK_SECRET the chain's providerUrl is NOT_CONNECTED and names the setting", async () => {
  const providerUrl = productionComposition(db.sql, { gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: prodSigner(null) }).providerUrl;
  assert.ok(providerUrl);
  await assert.rejects(
    () => providerUrl({ organizationId: PROD_ORG, uri: `store://${PROD_KIT}` }),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.includes("MEDIA_LINK_SECRET"),
  );
});

test("produce_shot's ports carry the composition's providerUrl, and none when the composition has none", () => {
  const composition = productionComposition(db.sql, { gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: prodSigner() });
  const shot = { media: fakeMedia(), objects: fakeObjects(), assetMedia: memoryMediaStore() };
  assert.equal(produceShotPortsOf(composition, shot).providerUrl, composition.providerUrl, "the production link is the one produce_shot uses");
  const bare: EngineComposition = { ...composition };
  delete bare.providerUrl;
  assert.equal(produceShotPortsOf(bare, shot).providerUrl, undefined, "no link port, no link: the adapters refuse the stored uris");
});

test("with shot ports, produce_shot and check_take are registered with the production composition's providerUrl", () => {
  const composition = productionComposition(db.sql, { gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: prodSigner() });
  const runtime = createEngineRuntime({
    ...composition,
    shotPorts: { media: fakeMedia(), objects: fakeObjects(), assetMedia: memoryMediaStore() },
  });
  assert.ok(runtime.handlers.produce_shot, "produce_shot is registered once the shot ports are given");
  assert.ok(runtime.handlers.check_take, "check_take is registered once the shot ports are given");
});

test("the production runtime registers no produce_shot: production gives no shot ports (media store, video profiles), so a cartoon chain fails closed", () => {
  const runtime = productionEngineRuntime(db.sql);
  assert.equal(runtime.handlers.produce_shot, undefined, "produce_shot stays not_implemented in production until its ports exist (jobs/STATUS.md)");
  assert.equal(runtime.handlers.check_take, undefined);
  assert.ok(runtime.handlers.intake && runtime.handlers.plan, "the stages with no provider are registered");
  assert.equal(productionEngineRuntime(db.sql), runtime, "one runtime per database handle");
});
