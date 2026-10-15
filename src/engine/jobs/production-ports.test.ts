import assert from "node:assert/strict";
import { test } from "node:test";
import { priceFor } from "../config/prices.ts";
import { EngineError, type ValidatedRequest } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { MediaStorePort } from "./artifact-store.ts";
import { notConnectedMediaLinks } from "./media-link.ts";
import { gatewayMediaFunctions, productionPostRenderPorts, productionRenderPorts, renderLineUsd } from "./production-ports.ts";
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
