// The production dependencies of render and post_render_review (Bible 6.11, 6.12, owner decision 2026-10-14). Each builder takes the
// gateway (the only network transport), the engine's object store (Meridian's Drive-backed store) and the media-link signer, and
// returns the ports the stage handlers take. Nothing is read from the environment here: keys come from the gateway's credential
// source, the signing secret and origin come from the signer, and the media functions' base URL comes from the gateway's provider
// table. A dependency that is not connected fails with a NOT_CONNECTED reason, so nothing is sent and nothing is priced on a guess.

import { priceFor } from "../config/prices.ts";
import { EngineError, roundUsd, type GateResult } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { textTransport } from "../gateway/text.ts";
import { httpMediaFunctions, type HttpMediaFunctions } from "../media/http.ts";
import type { MediaFunctions } from "../media/interface.ts";
import { checkRenderIntegrity } from "../media/integrity.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import { createHyperframesCloudAdapter, RENDER_EXPECTATION, type IntegrityInput, type RenderDeps } from "../render/hyperframesCloud.ts";
import { createShotstackAdapter, type ShotstackDeps } from "../render/shotstack.ts";
import { mediaKey, type MediaStorePort } from "./artifact-store.ts";
import { scopedLedgerStore } from "./asset-stores-sql.ts";
import { kitPorts } from "./kit-store.ts";
import { sourceUrlResolver, type MediaLinkSigner } from "./media-link.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import type { RenderPorts, RenderScope } from "./handlers/render.ts";
import type { RenderDetectors } from "./gate-measures.ts";

const MINUTE_MS = 60_000;

/**
 * The media functions over the gateway. The base URL is the gateway's media_functions provider (set by the deployment); with none,
 * every call fails with a NOT_CONNECTED config error before anything is sent. The connection is checked on each call, so a
 * deployment that sets the URL later needs no restart.
 */
export function gatewayMediaFunctions(gateway: Gateway): HttpMediaFunctions {
  const connected = async (): Promise<HttpMediaFunctions> => {
    const status = await gateway.connection("media_functions", null);
    if (!status.connected) {
      throw new EngineError(
        "config",
        notConnectedReason(`the media functions are not connected: ${status.reason ?? "no base URL is set on this deployment"}`),
        { stage: "media.client" },
      );
    }
    return httpMediaFunctions(gateway.baseUrlFor("media_functions"), textTransport(gateway.transportFor("media_functions", null)));
  };
  return {
    id: "gateway:media_functions",
    probe: async (request) => (await connected()).probe(request),
    frames: async (request) => (await connected()).frames(request),
    loudness: async (request) => (await connected()).loudness(request),
    cuts: async (request) => (await connected()).cuts(request),
    timeline: async (request) => (await connected()).timeline(request),
    picture: async (request) => (await connected()).picture(request),
    blackFrames: async (request) => (await connected()).blackFrames(request),
    flicker: async (request) => (await connected()).flicker(request),
    motion: async (request) => (await connected()).motion(request),
    silence: async (request) => (await connected()).silence(request),
  };
}

/** The brand a request's media is stored under (Bible 5.2). A request with no brand has nowhere to store media, so it is refused. */
async function brandOfRequest(sql: Sql, organizationId: string, requestId: string): Promise<string> {
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const brand = rows[0]?.brand_id ?? null;
  if (brand === null) {
    throw new EngineError("invalid_input", "the request has no brand, so its media cannot be stored (Bible 5.2)", { stage: "render" });
  }
  return brand;
}

/**
 * The render line of the reservation for one video of this length (Bible 14.2). It is priced at the higher of the HyperFrames and the
 * Shotstack per-minute list prices, so a fallback is never under-reserved. Undefined when the HyperFrames price is not known: the
 * render handler then fails render_price_known and nothing is rendered unpriced.
 */
export function renderLineUsd(durationMs: number): number | undefined {
  const hyperframes = priceFor("render_hyperframes_cloud").usd;
  if (hyperframes === null) return undefined;
  const shotstack = priceFor("render_shotstack").usd ?? 0;
  return roundUsd((durationMs / MINUTE_MS) * Math.max(hyperframes, shotstack));
}

/** The integrity check of a rendered file: its probe against the render expectation (1080 x 1920, 30 fps). Bible 6.11. */
function integrityCheck(media: Pick<MediaFunctions, "probe">): (input: IntegrityInput) => Promise<GateResult> {
  return async (input) => {
    // An ArrayBuffer-backed copy: the media source type takes Uint8Array<ArrayBuffer> (post-render-review.ts does the same).
    const probe = await media.probe({ source: { kind: "bytes", bytes: new Uint8Array(input.bytes) } });
    return checkRenderIntegrity({
      videoId: input.videoId,
      probe,
      edl: { durationMs: input.durationMs, width: RENDER_EXPECTATION.width, height: RENDER_EXPECTATION.height, fps: RENDER_EXPECTATION.fps },
    });
  };
}

export type ProductionRenderInput = {
  sql: Sql;
  gateway: Gateway;
  /** Meridian's object store for engine media (lib/meridian/storage/engine-media-link.ts, engineObjectStore). */
  objects: MediaStorePort;
  /** The media functions for the integrity probe. */
  media: Pick<MediaFunctions, "probe">;
  /** Signs the 15-minute links Shotstack fetches its sources by. Meridian's signer in production. */
  mediaLinks: MediaLinkSigner;
  now: () => string;
};

/**
 * The render ports of production: HyperFrames on HeyGen's cloud through the gateway's transport and key, Shotstack for component-free
 * EDLs through the gateway's transport and signed source links, the integrity check through the media functions, and the stored
 * video in the object store under the render's media key.
 */
export function productionRenderPorts(input: ProductionRenderInput): RenderPorts {
  const kits = kitPorts(input.sql);
  const sharedFor = (scope: RenderScope) => ({
    ledger: scopedLedgerStore(input.sql, scope.organizationId, scope.reservationId),
    verifyIntegrity: integrityCheck(input.media),
    storeVideo: async ({ videoId, bytes }: { videoId: string; bytes: Uint8Array }): Promise<string> => {
      const brandId = await brandOfRequest(input.sql, scope.organizationId, scope.requestId);
      const key = mediaKey({ workspaceId: scope.organizationId, requestId: scope.requestId, stage: "render", artifactId: videoId, extension: "mp4" });
      await input.objects.put({ organizationId: scope.organizationId, brandId, key, mimeType: "video/mp4", bytes });
      return key;
    },
  });
  const resolveAsset = async (scope: RenderScope, uri: string): Promise<Uint8Array> => {
    const brandId = await brandOfRequest(input.sql, scope.organizationId, scope.requestId);
    const object = await input.objects.get(scope.organizationId, brandId, uri);
    if (!object) throw new EngineError("not_found", "a media file of the composition is missing from the object store", { stage: "render" });
    return object.bytes;
  };
  return {
    loadStyleKit: kits.loadStyleKit,
    renderEstimateUsd: async (_scope, durationMs) => renderLineUsd(durationMs),
    hyperframes: (scope): RenderDeps => ({
      adapter: createHyperframesCloudAdapter({
        transport: input.gateway.transportFor("heygen", scope.organizationId),
        credential: input.gateway.secretFor("heygen", scope.organizationId),
      }),
      ...sharedFor(scope),
      resolveAsset: (uri) => resolveAsset(scope, uri),
    }),
    shotstack: (scope): ShotstackDeps => ({
      adapter: createShotstackAdapter({
        transport: input.gateway.transportFor("shotstack", scope.organizationId),
        connection: () => input.gateway.connection("shotstack", scope.organizationId),
        baseUrl: input.gateway.baseUrlFor("shotstack"),
      }),
      ...sharedFor(scope),
      resolveSourceUrl: sourceUrlResolver({ signer: input.mediaLinks, organizationId: scope.organizationId }),
    }),
    now: input.now,
  };
}

export type ProductionPostRenderInput = {
  gateway: Gateway;
  /** The media functions: frames, loudness, the timeline and the detectors of the rendered file. */
  media: HttpMediaFunctions;
  objects: MediaStorePort;
  now: () => string;
};

/**
 * The post-render ports of production (Bible 12.3): the media functions for loudness, timeline, frames and the detectors (black frames
 * and silence), the frame_reader role for the overlays on the rendered frames, and the final Critic through the gateway. OCR and the
 * forbidden-term check have no source yet, so their checks are not evaluated (review/STATUS.md decision 5).
 */
export function productionPostRenderPorts(input: ProductionPostRenderInput): PostRenderPorts {
  const detectors: RenderDetectors = input.media;
  return {
    gateway: input.gateway,
    media: input.media,
    detectors,
    objects: input.objects,
    frameReader: true,
    now: input.now,
  };
}
