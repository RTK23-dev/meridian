// The production dependencies of render and post_render_review (Bible 6.11, 6.12, owner decision 2026-10-14). Each builder takes the
// gateway (the only network transport), the engine's object store (Meridian's Drive-backed store) and the media-link signer, and
// returns the ports the stage handlers take. Nothing is read from the environment here: keys come from the gateway's credential
// source, the signing secret and origin come from the signer, and the media functions' base URL comes from the gateway's provider
// table. A dependency that is not connected fails with a NOT_CONNECTED reason, so nothing is sent and nothing is priced on a guess.

import { priceFor } from "../config/prices.ts";
import { EngineError, roundUsd, type GateResult, type Persona, type VoiceKit } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { textTransport } from "../gateway/text.ts";
import { httpMediaFunctions, type HttpMediaFunctions } from "../media/http.ts";
import type { MediaFunctionsMode } from "../media/mode.ts";
import type { MediaFunctions } from "../media/interface.ts";
import { checkRenderIntegrity } from "../media/integrity.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import { createHyperframesCloudAdapter, RENDER_EXPECTATION, type IntegrityInput, type RenderDeps } from "../render/hyperframesCloud.ts";
import { createShotstackAdapter, type ShotstackDeps } from "../render/shotstack.ts";
import { mediaKey, type MediaStorePort } from "./artifact-store.ts";
import { scopedLedgerStore } from "./asset-stores-sql.ts";
import { kitPorts, productKitBySku, readKit } from "./kit-store.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, sourceUrlResolver, type MediaLinkSigner } from "./media-link.ts";
import { readDriveConnectionMeta } from "../../lib/meridian/storage/drive-connection-store.ts";
import { sqlEventStore } from "./event-store-sql.ts";
import { withReservationLedger } from "./sql-ledger-store.ts";
import type { ProduceShotPorts } from "./handlers/produce-shot.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import type { RenderPorts, RenderScope } from "./handlers/render.ts";
import type { VariantGenerationPorts, VariantPorts } from "./handlers/variants.ts";
import type { WorkspaceBudgetSource } from "./handlers/estimate-reserve.ts";
import type { RenderDetectors } from "./gate-measures.ts";

const MINUTE_MS = 60_000;

/**
 * The reason the media functions cannot be called on this deployment, or null when they are connected. The gateway says why (the base
 * URL is not set). Sends nothing. In the in-process mode (MEDIA_FUNCTIONS_MODE=in_process) there is no base URL to check: the handlers run
 * in this process, so they are connected, and the ffmpeg binary is the one thing that can be missing (it fails as a config error on the
 * first run, with nothing spent).
 */
export async function mediaFunctionsProblem(gateway: Gateway, mode: MediaFunctionsMode = "http"): Promise<string | null> {
  if (mode === "in_process") return null;
  const status = await gateway.connection("media_functions", null);
  if (status.connected) return null;
  return notConnectedReason(`the media functions are not connected: ${status.reason ?? "no base URL is set on this deployment"}`);
}

/**
 * The media functions over the gateway. The base URL is the gateway's media_functions provider (set by the deployment, from
 * MEDIA_FUNCTIONS_BASE_URL in production); with none, every call fails with a NOT_CONNECTED config error before anything is sent.
 * The connection is checked on each call, so a deployment that sets the URL later needs no restart.
 */
export function gatewayMediaFunctions(gateway: Gateway): HttpMediaFunctions {
  const connected = async (): Promise<HttpMediaFunctions> => {
    const problem = await mediaFunctionsProblem(gateway);
    if (problem !== null) throw new EngineError("config", problem, { stage: "media.client" });
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
export async function brandOfRequest(sql: Sql, organizationId: string, requestId: string): Promise<string> {
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

/** The reason a variant's voice cannot be spoken in production: no voice port is built, so no voice call is made (variants/STATUS.md). */
const VOICE_NOT_WIRED = notConnectedReason(
  "the voice of a variant is not wired in production: the speech route, speech-to-text, the media functions and the audio loader have no deployment wiring yet",
);

export type ProductionVariantInput = {
  sql: Sql;
  gateway: Gateway;
  /** The Claude client's deps for one request on its reservation (the composition's roles). */
  roles: VariantGenerationPorts["roles"];
  /** Meridian's Settings, through workspace-budget.ts: the workspace's monthly budget. */
  workspaceBudget: WorkspaceBudgetSource;
  /** The style kit the validated request names: the same kit store the edit stage reads (kit-store.ts). */
  loadStyleKit: VariantPorts["loadStyleKit"];
  now: () => string;
};

/**
 * The variants stage's ports in production (Bible 6.13). The writer's route is read from the gateway, and its key comes from Meridian's
 * credential resolver: a route with no key is NOT_CONNECTED before any call. The kits are the workspace's engine_kits rows, the monthly budget
 * is Meridian's Settings, and the events are the engine's table. The voice is not connected (VOICE_NOT_WIRED), and music is not either, so a
 * variant that needs a voice is reported NOT_CONNECTED with its reason, and no music variant is built.
 */
export function productionVariantPorts(input: ProductionVariantInput): VariantPorts {
  return {
    loadMusicTrack: async () => undefined,
    withLedger: (scope, fn) => withReservationLedger(input.sql, scope.organizationId, scope.reservationId, fn),
    events: sqlEventStore(input.sql),
    now: input.now,
    loadStyleKit: input.loadStyleKit,
    workspaceMonthBudget: async (scope) => {
      const month = await input.workspaceBudget.monthBudget({ organizationId: scope.organizationId, requestId: scope.requestId, now: scope.now });
      return month.status === "known" ? month.usd : null;
    },
    generation: {
      roles: input.roles,
      connection: async (scope) => ({ writer: await writerReasonOf(input.gateway, scope.organizationId), voice: VOICE_NOT_WIRED }),
      loadProductKit: (scope) => productKitBySku(input.sql, scope),
      loadPersona: async (scope) => (await readKit<Persona>(input.sql, { organizationId: scope.organizationId, kind: "persona", kitId: scope.personaId }))?.body,
      loadVoiceKit: async (scope) => (await readKit<VoiceKit>(input.sql, { organizationId: scope.organizationId, kind: "voice", kitId: scope.voiceId }))?.body,
    },
  };
}

/** Whether the writer's route can be called for a workspace: its provider is connected. The NOT_CONNECTED reason when it is not. No call is made. */
async function writerReasonOf(gateway: Gateway, organizationId: string): Promise<string | null> {
  let providerId: string;
  try {
    providerId = gateway.route("llm.check").provider.id;
  } catch (error) {
    return notConnectedReason(error instanceof Error ? error.message : "the writer's route has no model");
  }
  const status = await gateway.connection(providerId, organizationId);
  return status.connected ? null : notConnectedReason(status.reason ?? `the ${providerId} key is not connected for this workspace`);
}

/** The link a chain input gets for the provider that reads it (Bible 10.1): an https URL the provider can fetch (produce-shot.ts linksFor). */
export type ProviderUrl = NonNullable<ProduceShotPorts["providerUrl"]>;

/**
 * The model classes a chain's calls can use (contract v5, Bible 7.1). Their routes name the providers a chain's calls reach, so the
 * providers of these routes are the ones whose base URL a chain needs.
 */
export const CHAIN_MODEL_CLASSES = ["image.keyframe", "image.edit", "video.cinematic", "video.budget", "video.i2v_pinned"] as const;

/** The providers a chain's calls go to: the providers of the routed targets of its model classes, in route order, each once. */
export function chainProvidersOf(gateway: Gateway): string[] {
  const providers: string[] = [];
  for (const modelClass of CHAIN_MODEL_CLASSES) {
    for (const route of gateway.routes(modelClass)) {
      if (!providers.includes(route.provider.id)) providers.push(route.provider.id);
    }
  }
  return providers;
}

/** The URI scheme of Meridian's store. A kit image is store://<object key> (Bible 13). A uri without it is taken as an object key. */
export const STORE_URI_PREFIX = "store://";

/** The object key a chain input's uri names: the key after the store scheme, or the uri itself. */
export function objectKeyOfUri(uri: string): string {
  return uri.startsWith(STORE_URI_PREFIX) ? uri.slice(STORE_URI_PREFIX.length) : uri;
}

/** The reason a provider has no base URL on this deployment, or null when it has one. The gateway sends nothing here. */
function baseUrlProblem(gateway: Gateway, providerId: string): string | null {
  try {
    gateway.baseUrlFor(providerId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `${providerId} has no base URL set on this deployment`;
  }
}

export type ProductionProviderUrlInput = {
  gateway: Gateway;
  /** Meridian's signer (lib/meridian/storage/engine-media-link.ts) in production; the engine never reads the secret itself. */
  mediaLinks: MediaLinkSigner;
};

/**
 * The providerUrl of production (Bible 10.1). A chain input becomes a 15-minute https link to its engine object or kit image, for the
 * organization of the call. Before any link is signed, every provider the chain reaches must have a base URL on this deployment: one
 * with none is NOT_CONNECTED, with its reason, and nothing is signed. An input the signer refuses (another organization's object, or a
 * uri that is neither an engine object nor a kit image) is invalid input: the chain stops there as a hold, and no link is made.
 */
export function productionProviderUrl(input: ProductionProviderUrlInput): ProviderUrl {
  return async ({ organizationId, uri }) => {
    for (const providerId of chainProvidersOf(input.gateway)) {
      const problem = baseUrlProblem(input.gateway, providerId);
      if (problem !== null) {
        throw new EngineError("config", notConnectedReason(`the chain's provider cannot be called: ${problem}`), { stage: "produce_shot" });
      }
    }
    const result = await input.mediaLinks.sign(organizationId, objectKeyOfUri(uri), ENGINE_MEDIA_LINK_TTL_SECONDS);
    if (result.status === "not_connected") {
      throw new EngineError("config", notConnectedReason(`a chain input cannot be linked: ${result.reason}`), { stage: "produce_shot" });
    }
    if (result.status === "refused") {
      throw new EngineError("invalid_input", `a chain input cannot be linked: ${result.reason}`, { stage: "produce_shot" });
    }
    if (!result.url.startsWith("https://")) {
      throw new EngineError("config", "the signed link for a chain input is not https, so the provider cannot fetch it", { stage: "produce_shot" });
    }
    return result.url;
  };
}

export type ShotConnection = (organizationId: string) => Promise<string | null>;

/**
 * The reason a shot's ports cannot make or store a take for this workspace, or null when they can. It is checked before any paid call
 * (produce_shot, check_take): the media functions must be connected, and the workspace's Google Drive must be connected, because a
 * finished image or take is stored there after it is paid for. Sends nothing and makes no paid call (Bible 10.4, 14, fail closed).
 * The Drive check reads whether the workspace has a connection, not whether its token opens: an unreadable token still fails the store.
 */
export function productionShotConnection(input: { sql: Sql; gateway: Gateway; mediaFunctionsMode?: MediaFunctionsMode }): ShotConnection {
  return async (organizationId) => {
    const media = await mediaFunctionsProblem(input.gateway, input.mediaFunctionsMode ?? "http");
    if (media !== null) return media;
    const drive = await readDriveConnectionMeta(input.sql, organizationId);
    if (!drive.connected) {
      return notConnectedReason("Google Drive is not connected for this workspace, so a take's media cannot be stored (Bible 5.2)");
    }
    return null;
  };
}
