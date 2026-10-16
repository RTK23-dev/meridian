import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFor } from "../config/prices.ts";
import { EngineError, type ValidatedRequest } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { MediaStorePort } from "./artifact-store.ts";
import { notConnectedMediaLinks, type MediaLinkSigner } from "./media-link.ts";
import { engineMediaLinkSigner } from "../../lib/meridian/storage/engine-media-link.ts";
import {
  chainProvidersOf,
  gatewayMediaFunctions,
  mediaFunctionsProblem,
  objectKeyOfUri,
  productionPostRenderPorts,
  productionProviderUrl,
  productionRenderPorts,
  productionShotConnection,
  renderLineUsd,
} from "./production-ports.ts";
import type { RenderScope } from "./handlers/render.ts";
import { createGateway } from "../gateway/gateway.ts";
import { gatewayWith, keySource, recordedTransport } from "./test/harness.ts";

const SCOPE: RenderScope = {
  organizationId: "org_prod",
  requestId: "req_prod",
  reservationId: "res_prod",
  validated: {} as ValidatedRequest,
};

/** The SQL handle is never queried in these tests: the ports only close over it. */
const NO_SQL = {} as unknown as Sql;

const NO_OBJECTS: MediaStorePort = {
  async put(input) {
    return { key: input.key, checksum: "0".repeat(64), size: input.bytes.byteLength };
  },
  async get() {
    return null;
  },
};

test("the render line is unknown (undefined) while the HyperFrames list price is unknown, and priced per minute once it is known", () => {
  const hyperframes = priceFor("render_hyperframes_cloud").usd;
  if (hyperframes === null) {
    assert.equal(renderLineUsd(60_000), undefined, "no price, no render (Bible 14.2)");
  } else {
    assert.ok(renderLineUsd(60_000) !== undefined && (renderLineUsd(60_000) ?? 0) >= hyperframes);
  }
});

test("the media functions are not connected without a base URL, and no request is sent", async () => {
  const { transport, requests } = recordedTransport({});
  const media = gatewayMediaFunctions(gatewayWith(transport));
  await assert.rejects(
    () => media.probe({ source: { kind: "bytes", bytes: new Uint8Array(4) } }),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED"),
  );
  assert.equal(requests.length, 0);
});

/** A gateway whose media functions have a base URL (the deployment's setting), and no key: the media functions carry none. */
function mediaGateway() {
  return createGateway({
    transport: recordedTransport({}).transport,
    credentials: keySource({}),
    providers: { media_functions: { baseUrl: "https://fn.example.com" } },
  });
}

/** A SQL handle that answers every statement with the given rows. Only the Drive connection read runs through it here. */
function sqlAnswering(rows: unknown[]): Sql {
  return (async () => rows) as unknown as Sql;
}

/** A SQL handle that fails when it is read: a check that returns before the database must never touch it. */
const SQL_MUST_NOT_RUN = (() => {
  throw new Error("the database was read");
}) as unknown as Sql;

test("the media functions are a problem with their NOT_CONNECTED reason until the deployment sets a base URL", async () => {
  const unset = gatewayWith(recordedTransport({}).transport);
  assert.ok((await mediaFunctionsProblem(unset))?.startsWith("NOT_CONNECTED: the media functions are not connected: media_functions has no base URL"));
  assert.equal(await mediaFunctionsProblem(mediaGateway()), null);
});

test("the shot connection names the media functions when they are not connected, and reads nothing else", async () => {
  const reason = await productionShotConnection({ sql: SQL_MUST_NOT_RUN, gateway: gatewayWith(recordedTransport({}).transport) })("org_prod");
  assert.ok(reason?.startsWith("NOT_CONNECTED: the media functions are not connected"));
});

test("with the media functions connected, a workspace with no Drive connection is NOT_CONNECTED: a take has nowhere to be stored", async () => {
  const reason = await productionShotConnection({ sql: sqlAnswering([]), gateway: mediaGateway() })("org_prod");
  assert.ok(reason?.startsWith("NOT_CONNECTED: Google Drive is not connected for this workspace"), reason ?? "no reason");
});

test("with the media functions and the workspace's Drive connected, the shot connection is ready (null)", async () => {
  const connected = sqlAnswering([{ created_at: new Date("2026-10-01T00:00:00.000Z") }]);
  assert.equal(await productionShotConnection({ sql: connected, gateway: mediaGateway() })("org_prod"), null);
});

test("the HyperFrames adapter sends nothing without a HeyGen key, and says so", async () => {
  const { transport, requests } = recordedTransport({});
  const ports = productionRenderPorts({
    sql: NO_SQL,
    gateway: gatewayWith(transport),
    objects: NO_OBJECTS,
    media: { probe: async () => Promise.reject(new Error("not called")) },
    mediaLinks: notConnectedMediaLinks("test: no signer"),
    now: () => "2026-10-15T14:00:00.000Z",
  });
  const deps = ports.hyperframes(SCOPE);
  await assert.rejects(
    () => deps.adapter.ready(),
    (error: unknown) => error instanceof EngineError && error.kind === "config",
  );
  assert.equal(requests.length, 0);
});

test("a Shotstack source link is refused with NOT_CONNECTED when the signer is not connected", async () => {
  const { transport } = recordedTransport({});
  const ports = productionRenderPorts({
    sql: NO_SQL,
    gateway: gatewayWith(transport),
    objects: NO_OBJECTS,
    media: { probe: async () => Promise.reject(new Error("not called")) },
    mediaLinks: notConnectedMediaLinks("MEDIA_LINK_SECRET is not set"),
    now: () => "2026-10-15T14:00:00.000Z",
  });
  const shotstack = ports.shotstack;
  assert.ok(shotstack, "the production render ports carry Shotstack");
  await assert.rejects(
    () => shotstack(SCOPE).resolveSourceUrl("engine/org_prod/req_prod/take/take_1.mp4"),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED"),
  );
});

test("a signed source link is the URL Shotstack is given, over https, for the organization of the request", async () => {
  const { transport } = recordedTransport({});
  const seen: Array<{ org: string; key: string; ttl: number }> = [];
  const ports = productionRenderPorts({
    sql: NO_SQL,
    gateway: gatewayWith(transport),
    objects: NO_OBJECTS,
    media: { probe: async () => Promise.reject(new Error("not called")) },
    mediaLinks: {
      async sign(org, key, ttl) {
        seen.push({ org, key, ttl });
        return { status: "ok", url: `https://meridian.example.com/api/engine-media?key=${key}` };
      },
    },
    now: () => "2026-10-15T14:00:00.000Z",
  });
  const shotstack = ports.shotstack;
  assert.ok(shotstack);
  const url = await shotstack(SCOPE).resolveSourceUrl("engine/org_prod/req_prod/take/take_1.mp4");
  assert.match(url, /^https:\/\//);
  assert.deepEqual(seen, [{ org: "org_prod", key: "engine/org_prod/req_prod/take/take_1.mp4", ttl: 900 }]);
});

test("the post-render ports read overlays with the frame reader and use the media functions as the detectors", () => {
  const { transport } = recordedTransport({});
  const media = gatewayMediaFunctions(gatewayWith(transport));
  const ports = productionPostRenderPorts({ gateway: gatewayWith(transport), media, objects: NO_OBJECTS, now: () => "2026-10-15T14:00:00.000Z" });
  assert.equal(ports.frameReader, true);
  assert.equal(ports.detectors, media);
  assert.equal(ports.media, media);
  assert.equal(ports.measureOverlays, undefined, "no overlay port overrides the frame reader");
  assert.equal(ports.measureOcr, undefined, "OCR has no source yet, so its check is not evaluated");
});

test("the HyperFrames adapter is ready when Meridian's resolver holds a HeyGen key, and ready() sends nothing", async () => {
  const { transport, requests } = recordedTransport({});
  const gateway = createGateway({ transport, credentials: keySource({ heygen: "hg-test-key" }) });
  const ports = productionRenderPorts({
    sql: NO_SQL,
    gateway,
    objects: NO_OBJECTS,
    media: { probe: async () => Promise.reject(new Error("not called")) },
    mediaLinks: notConnectedMediaLinks("test: no signer"),
    now: () => "2026-10-15T14:00:00.000Z",
  });
  await ports.hyperframes(SCOPE).adapter.ready();
  assert.equal(requests.length, 0, "the readiness check reads the key and sends no request");
});

test("the Shotstack adapter is not ready without a Shotstack key, and says so before any request", async () => {
  const { transport, requests } = recordedTransport({});
  const gateway = createGateway({ transport, credentials: keySource({ heygen: "hg-test-key" }) });
  const ports = productionRenderPorts({
    sql: NO_SQL,
    gateway,
    objects: NO_OBJECTS,
    media: { probe: async () => Promise.reject(new Error("not called")) },
    mediaLinks: notConnectedMediaLinks("test: no signer"),
    now: () => "2026-10-15T14:00:00.000Z",
  });
  const shotstack = ports.shotstack;
  assert.ok(shotstack);
  await assert.rejects(
    () => shotstack(SCOPE).adapter.ready(),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.includes("shotstack is not connected"),
  );
  assert.equal(requests.length, 0);
});

// The chain's providerUrl (Bible 10.1). Each test uses the production linker, with the signer's secret and origin given, and a gateway
// whose providers are the deployment's.

const CHAIN_ORG = "org_prod";
const CHAIN_BRAND = "brand_prod";
const CHAIN_SECRET = "y".repeat(40);
const CHAIN_ORIGIN = "https://meridian.example.com";
const CHAIN_NOW = 1_800_000_000;
const KIT_OF_ORG = `kits/${CHAIN_ORG}/${CHAIN_BRAND}/character/char_1/sheet-1.png`;

/** A signer over the Meridian implementation, with its secret and origin given, that records every call it is asked for. */
function recordingSigner(options: { secret?: string | null } = {}): { signer: MediaLinkSigner; calls: Array<{ org: string; key: string; ttl: number; status: string }> } {
  const real = engineMediaLinkSigner({
    secret: () => (options.secret === undefined ? CHAIN_SECRET : options.secret),
    origin: () => CHAIN_ORIGIN,
    nowSeconds: () => CHAIN_NOW,
  });
  const calls: Array<{ org: string; key: string; ttl: number; status: string }> = [];
  return {
    calls,
    signer: {
      async sign(org, key, ttl) {
        const result = await real.sign(org, key, ttl);
        calls.push({ org, key, ttl, status: result.status });
        return result;
      },
    },
  };
}

test("the chain's providers are the providers of its image and video routes, each once (openrouter in the default table)", () => {
  assert.deepEqual(chainProvidersOf(gatewayWith(recordedTransport({}).transport)), ["openrouter"]);
});

test("the production providerUrl links a kit image of the organization over https, for 15 minutes, and the link names the key", async () => {
  const { signer } = recordingSigner();
  const providerUrl = productionProviderUrl({ gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: signer });
  const link = new URL(await providerUrl({ organizationId: CHAIN_ORG, uri: `store://${KIT_OF_ORG}` }));
  assert.equal(link.protocol, "https:");
  assert.equal(link.origin, CHAIN_ORIGIN);
  assert.equal(link.searchParams.get("org"), CHAIN_ORG);
  assert.equal(link.searchParams.get("key"), KIT_OF_ORG, "the store scheme is dropped: the key is the kit image's object key");
  assert.equal(Number(link.searchParams.get("expires")), CHAIN_NOW + 15 * 60);
});

test("the production providerUrl links an engine object of the organization (a take or an output of an earlier call)", async () => {
  const { signer } = recordingSigner();
  const providerUrl = productionProviderUrl({ gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: signer });
  const key = `engine/${CHAIN_ORG}/req_prod/image/img_1.png`;
  const link = new URL(await providerUrl({ organizationId: CHAIN_ORG, uri: key }));
  assert.equal(link.searchParams.get("key"), key);
});

test("a chain provider with no base URL on this deployment is NOT_CONNECTED with its reason, and nothing is signed", async () => {
  const gateway = createGateway({
    transport: recordedTransport({}).transport,
    credentials: keySource({ openrouter: "sk-or-test" }),
    providers: { openrouter: { baseUrl: null } },
  });
  const { signer, calls } = recordingSigner();
  const providerUrl = productionProviderUrl({ gateway, mediaLinks: signer });
  await assert.rejects(
    () => providerUrl({ organizationId: CHAIN_ORG, uri: `store://${KIT_OF_ORG}` }),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "config" &&
      error.message.startsWith("NOT_CONNECTED: ") &&
      error.message.includes("openrouter has no base URL set on this deployment"),
  );
  assert.equal(calls.length, 0, "the base URL is checked before the signer is asked: no link, no call");
});

test("without MEDIA_LINK_SECRET the chain's providerUrl is NOT_CONNECTED and names the setting", async () => {
  const { signer } = recordingSigner({ secret: null });
  const providerUrl = productionProviderUrl({ gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: signer });
  await assert.rejects(
    () => providerUrl({ organizationId: CHAIN_ORG, uri: `store://${KIT_OF_ORG}` }),
    (error: unknown) => error instanceof EngineError && error.kind === "config" && error.message.startsWith("NOT_CONNECTED: ") && error.message.includes("MEDIA_LINK_SECRET"),
  );
});

test("another organization's kit image is refused as invalid input (a hold for the chain), not as a service fault, and nothing is linked", async () => {
  const { signer, calls } = recordingSigner();
  const providerUrl = productionProviderUrl({ gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: signer });
  const otherOrgKit = "kits/org_other/brand_x/character/char_9/sheet.png";
  await assert.rejects(
    () => providerUrl({ organizationId: CHAIN_ORG, uri: `store://${otherOrgKit}` }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && !error.message.startsWith("NOT_CONNECTED"),
  );
  assert.deepEqual(calls.map((call) => call.status), ["refused"], "the signer refused it and signed nothing");
});

test("a uri that is neither an engine object nor a kit image of the organization is invalid input, and no link is made", async () => {
  const { signer } = recordingSigner();
  const providerUrl = productionProviderUrl({ gateway: gatewayWith(recordedTransport({}).transport), mediaLinks: signer });
  for (const uri of ["memory://org_prod/abc", "store://characters/fixture/sheet-1.png", "store://kits/org_prod/brand_prod/voice/v1/x.png"]) {
    await assert.rejects(
      () => providerUrl({ organizationId: CHAIN_ORG, uri }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
      uri,
    );
  }
});

test("the store scheme is the only prefix dropped: a uri without it is the object key itself", () => {
  assert.equal(objectKeyOfUri(`store://${KIT_OF_ORG}`), KIT_OF_ORG);
  assert.equal(objectKeyOfUri(`engine/${CHAIN_ORG}/req_prod/image/img_1.png`), `engine/${CHAIN_ORG}/req_prod/image/img_1.png`);
});
