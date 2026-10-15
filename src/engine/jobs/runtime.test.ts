import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { fakeMedia, fakeObjects, gatewayWith, json, keySource, recordedTransport } from "./test/harness.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import {
  createEngineRuntime,
  productionComposition,
  productionEngineRuntime,
  produceShotPortsOf,
  shotGeneratorOf,
  UNBOUND_ASSET_MEDIA,
  type EngineComposition,
  type ShotPorts,
} from "./runtime.ts";
import { videoProfileLoader } from "../assets/video-profiles.ts";
import { assetSpec } from "../assets/test/recorded.ts";
import type { StageContext } from "./types.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import type { RenderPorts } from "./handlers/render.ts";
import { EngineError } from "../contracts/index.ts";
import { memoryMediaStore } from "../assets/adapter.ts";
import { createGateway } from "../gateway/gateway.ts";
import { engineMediaLinkSigner } from "../../lib/meridian/storage/engine-media-link.ts";

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
const PNG_DIGEST = createHash("sha256").update(PNG).digest("hex");
const SHOT_BRAND_REQUEST = "req_shot_brand";
const SHOT_NO_BRAND_REQUEST = "req_shot_nobrand";

/**
 * Inserts one engine request in the production test workspace, on the brand its media is stored under, or on no brand. The row is the
 * one brandOfRequest reads (engine_requests), so a test seeds the brand the store and the take are keyed by.
 */
async function seedRequest(requestId: string, brandId: string | null): Promise<void> {
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${requestId}, ${PROD_ORG}, ${brandId}, 'fmt_shot', 'normal', 'running', '{}')
    on conflict do nothing
  `;
}

/** The input of one generate call for a request in the production workspace. */
function generateOf(requestId: string, spec = assetSpec()) {
  return { sql: db.sql, organizationId: PROD_ORG, requestId, reservationId: "res_shot", spec, visualType: "product_hero" };
}

test("production registers produce_shot and check_take, once per database handle", () => {
  const runtime = productionEngineRuntime(db.sql);
  assert.ok(runtime.handlers.produce_shot, "produce_shot is registered in production");
  assert.ok(runtime.handlers.check_take, "check_take is registered in production");
  assert.ok(runtime.handlers.intake && runtime.handlers.plan, "the stages with no provider are registered");
  assert.equal(productionEngineRuntime(db.sql), runtime, "one runtime per database handle");
});

test("with no media functions URL, a production shot is refused with its named reason, and no call is made", async () => {
  const { transport, requests } = recordedTransport({});
  const composition = productionComposition(db.sql, {
    gateway: gatewayWith(transport),
    mediaLinks: prodSigner(),
    objects: fakeObjects(),
    mediaFunctionsBaseUrl: null,
  });
  const shot = composition.shotPorts;
  assert.ok(shot, "the production composition carries the shot ports");
  const outcome = await produceShotPortsOf(composition, shot).generator.generate(generateOf(SHOT_BRAND_REQUEST));
  if (outcome.status !== "not_connected") assert.fail(`expected not_connected, got ${outcome.status}`);
  assert.match(outcome.reasons[0] ?? "", /^NOT_CONNECTED: the media functions are not connected: media_functions has no base URL/);
  assert.equal(requests.length, 0, "nothing is sent: no listing, no generation");
});

test("production shot ports are built with the engine object store and a store bound to each request", async () => {
  await seedRequest(SHOT_BRAND_REQUEST, "brand_runtime");
  const objects = fakeObjects();
  const composition = productionComposition(db.sql, {
    gateway: gatewayWith(recordedTransport({}).transport),
    mediaLinks: prodSigner(),
    objects,
    mediaFunctionsBaseUrl: null,
  });
  const shot = composition.shotPorts;
  assert.ok(shot, "the production composition carries the shot ports");
  assert.equal(shot.objects, objects, "the takes are written to the engine object store");
  assert.ok(shot.videoProfiles, "the video profiles are loaded from the listing");
  assert.equal(shot.assetMedia, UNBOUND_ASSET_MEDIA, "without a request, no bytes are stored");

  const bound = shot.assetMediaFor?.({ organizationId: PROD_ORG, requestId: SHOT_BRAND_REQUEST });
  assert.ok(bound, "the asset store is bound to each request");
  const written = await bound.put({ workspaceId: PROD_ORG, bytes: PNG, mediaType: "image/png", contentHash: `sha256:${PNG_DIGEST}` });
  assert.equal(written.uri, `engine/${PROD_ORG}/${SHOT_BRAND_REQUEST}/assets/${PNG_DIGEST}.png`);
  assert.ok(objects.objects.has(`${PROD_ORG}|brand_runtime|${written.uri}`), "the image is stored under the request's brand");
  await assert.rejects(
    shot.assetMedia.put({ workspaceId: PROD_ORG, bytes: PNG, mediaType: "image/png", contentHash: `sha256:${PNG_DIGEST}` }),
    /not bound to a request/,
  );
});

test("a video shot is refused with the listing's reason when no video profile is eligible, before any paid call", async () => {
  const { transport, requests } = recordedTransport({ "GET /api/v1/videos/models": json(500, { error: "down" }) });
  const gateway = gatewayWith(transport);
  const shotPorts: ShotPorts = {
    media: fakeMedia(),
    objects: fakeObjects(),
    assetMedia: UNBOUND_ASSET_MEDIA,
    videoProfiles: videoProfileLoader({ gateway }),
    shotConnection: async () => null,
  };
  const outcome = await shotGeneratorOf(composition({ gateway, shotPorts }), shotPorts).generate(generateOf(SHOT_BRAND_REQUEST));
  if (outcome.status !== "not_connected") assert.fail(`expected not_connected, got ${outcome.status}`);
  assert.match(outcome.reasons[0] ?? "", /GET \/videos\/models could not be read: the provider answered 500/);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET"],
    "only the free listing was read; no video was submitted",
  );
});

test("an image shot reads no video listing, and a request with no brand is refused before its paid call", async () => {
  await seedRequest(SHOT_NO_BRAND_REQUEST, null);
  const { transport, requests } = recordedTransport({});
  const gateway = gatewayWith(transport);
  const shotPorts: ShotPorts = {
    media: fakeMedia(),
    objects: fakeObjects(),
    assetMedia: UNBOUND_ASSET_MEDIA,
    videoProfiles: videoProfileLoader({ gateway }),
    shotConnection: async () => null,
  };
  const generator = shotGeneratorOf(composition({ gateway, shotPorts }), shotPorts);
  await assert.rejects(
    generator.generate(generateOf(SHOT_NO_BRAND_REQUEST, assetSpec({ modelClass: "image.keyframe" }))),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal(requests.length, 0, "no listing and no image call were made");
});

test("check_take is refused with its reason, before it reads the take, when the shot ports are not connected", async () => {
  const shotPorts: ShotPorts = {
    media: fakeMedia(),
    objects: fakeObjects(),
    assetMedia: UNBOUND_ASSET_MEDIA,
    shotConnection: async () => "NOT_CONNECTED: Google Drive is not connected for this workspace",
  };
  const handler = createEngineRuntime(composition({ shotPorts })).handlers.check_take;
  assert.ok(handler, "check_take is registered with its shot ports");
  await assert.rejects(
    handler.run({ organizationId: PROD_ORG } as unknown as StageContext),
    (error: unknown) =>
      error instanceof EngineError && error.kind === "config" && error.message === "NOT_CONNECTED: Google Drive is not connected for this workspace",
  );
});
