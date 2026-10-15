// The engine runtime's composition root (Bible 5.1, E3 lead decision 7). It takes the database, the gateway and the stores, and
// registers every stage handler that is built. A stage with no handler stays not_implemented, so the dispatcher refuses it and
// never marks it done. Meridian's worker runs engine jobs with productionEngineRuntime(sql) (lib/meridian/jobs/execute.ts).
//
// What is registered, and what is not (E3 status, see STATUS.md):
//   - always: intake, plan, estimate_reserve, edit. They need the database, the gateway (for the Claude roles), the kits and the
//     workspace's monthly budget (Meridian's Settings, through workspaceBudgetFromSettings).
//   - with shotPorts: produce_shot and check_take. Their media functions, object store and asset-media store are deployment
//     wiring that does not exist yet, so production does not register them. They stay not_implemented, which fails closed.
//     The chain's providerUrl (Bible 10.1) is built by productionComposition from the gateway's base URLs and Meridian's
//     signer, and passed to produce_shot with the shot ports, so it is ready when the shot ports are. A chain provider with no
//     base URL makes that link NOT_CONNECTED with its reason (jobs/STATUS.md).
//   - with their ports: analyze_reference (the `analysis` ports) and voice (the `voice` ports), both W6. Without ports they stay
//     not_implemented. A composition may also pass a handler for render (W10) through `handlers`.
//   - E4 and E5 (this file, later pass): compose, pre_render_gate, variants and deliver are always registered. They need no provider:
//     the kit store, the engine tables and the reservation's ledger. render (the HyperFrames and Shotstack deps) and
//     post_render_review (the media, the object store and the Critic) are registered only when composition.render and
//     composition.postRender are given. Production gives both (production-ports.ts): HyperFrames and Shotstack through the gateway,
//     the engine's objects in Meridian's store, 15-minute source links from Meridian's signer, and the media functions over the
//     gateway. Each one fails closed on its own: no media functions URL, no signer secret, or no HyperFrames price stops the stage.
//   - the media detectors (check_take, post_render_review) and the frame_reader readings (analyze_reference, post_render_review) are
//     wired through gate-measures.ts and analyze/frameReader.ts. They are optional ports; without them their checks are not evaluated.
//
// No key is read here: the gateway takes its credentials from Meridian's resolver, and the transport is the gateway's own.

import { createAssetRouter, type AsyncAssetRouter, type RouterSettings } from "../assets/router.ts";
import type { MediaStore } from "../assets/adapter.ts";
import type { VideoProfile } from "../assets/providers/openrouterVideo.ts";
import { adapterFor, stockProviderFor } from "../assets/providers/index.ts";
import type { ModelClass, ProviderAdapter } from "../contracts/index.ts";
import { createAnalyzeReferenceHandler } from "./handlers/analyze-reference.ts";
import { createVoiceHandler, type VoiceStagePorts } from "./handlers/voice.ts";
import type { ReferencePorts } from "../analyze/reference.ts";
import { analysisReadings } from "../analyze/frameReader.ts";
import type { PictureClient } from "../media/index.ts";
import type { TakeDetectors } from "./gate-measures.ts";
import {
  gatewayMediaFunctions,
  productionPostRenderPorts,
  productionProviderUrl,
  productionRenderPorts,
  productionVariantPorts,
  type ProviderUrl,
} from "./production-ports.ts";
import { engineMediaLinkSigner, engineObjectStore } from "../../lib/meridian/storage/engine-media-link.ts";
import type { MediaLinkSigner } from "./media-link.ts";
import { searchStock } from "../assets/stock.ts";
import { createGateway, type Gateway } from "../gateway/gateway.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import { meridianCredentialSource } from "../gateway/meridian.ts";
import { fetchHttpTransport } from "../gateway/transport.ts";
import type { MediaFunctions } from "../media/interface.ts";
import type { SimilarityScorer } from "../review/take/similarity.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { RoleDeps } from "../claude/client.ts";
import { sqlRoleCallJournal } from "./role-call-store.ts";
import { scopedLedgerStore, sqlAssetCache, sqlBreakerStore, sqlBucketStore, sqlProviderStats } from "./asset-stores-sql.ts";
import { workspaceBudgetFromSettings, meridianMonthlyBudgetReader } from "./workspace-budget.ts";
import { createEditHandler } from "./handlers/edit.ts";
import { createEstimateReserveHandler, type WorkspaceBudgetSource } from "./handlers/estimate-reserve.ts";
import { createCheckTakeHandler, type CheckTakePorts } from "./handlers/check-take.ts";
import { createIntakeHandler, type IntakePorts } from "./handlers/intake.ts";
import { createPlanHandler } from "./handlers/plan.ts";
import { createProduceShotHandler, routerGenerator, type ProduceShotPorts } from "./handlers/produce-shot.ts";
import { registerEngineHandlers } from "./handlers/register.ts";
import { kitPorts } from "./kit-store.ts";
import type { MediaStorePort } from "./artifact-store.ts";
import type { EngineRuntime, StageHandler } from "./types.ts";
import { createPreRenderGateHandler, type PreRenderPorts } from "./handlers/pre-render-gate.ts";
import type { StyleKit, ValidatedRequest } from "../contracts/index.ts";
import { createPostRenderReviewHandler, type PostRenderPorts } from "./handlers/post-render-review.ts";
import { createComposeHandler } from "./handlers/compose.ts";
import { createRenderHandler, type RenderPorts } from "./handlers/render.ts";
import { createVariantsHandler, type VariantPorts } from "./handlers/variants.ts";
import { createDeliverHandler, type DeliverPorts } from "./handlers/deliver.ts";
import { sqlEventStore } from "./event-store-sql.ts";
import { decisionsOf, gateResultsOf } from "./engine-reads-sql.ts";
import { withReservationLedger } from "./sql-ledger-store.ts";
import { listRoleCalls } from "./role-call-store.ts";

/** The stages built in other workstreams (W6: analyze_reference and voice; W10: render). Registered only when given. */
export type ExternalStageHandlers = Partial<Record<"analyze_reference" | "voice" | "render", StageHandler>>;

/** The ports the two generation stages need. All of them are required together, or the stages are not registered. */
export type ShotPorts = {
  media: Pick<MediaFunctions, "probe" | "frames">;
  /** The object store the takes' media is written to (Bible 5.2). */
  objects: MediaStorePort;
  /** The asset router's store for image and speech bytes. Video and stock results are URLs and need none. */
  assetMedia: MediaStore;
  /** The video models' profiles from the provider's listing (E2 harness). Empty means no video model is eligible. */
  videoProfiles?: ReadonlyMap<string, VideoProfile>;
  routerSettings?: Partial<RouterSettings>;
  sleep?: (ms: number) => Promise<void>;
  /** The similarity scorer (Bible 20.2). Absent, the similarity checks are missing evidence and escalate. */
  similarity?: SimilarityScorer;
  /** The media detectors of check_take (Bible 6.7 step 1): black or frozen frames, flicker and motion. Absent, those checks are missing evidence. */
  detectors?: TakeDetectors;
};

export type EngineComposition = {
  sql: Sql;
  gateway: Gateway;
  /** The workspace's monthly budget (Bible 14.1 step 2). Production: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)). */
  workspaceBudget: WorkspaceBudgetSource;
  /** The clock as an ISO time (ledger entries, artifacts). Defaults to the wall clock. */
  now?: () => string;
  /** The VideoDNA lookup (Bible 6.1 step 5). Absent, intake fails its dna_lookup check: no lookup is made and nothing is assumed. */
  lookupDna?: IntakePorts["lookupDna"];
  /** analyze_reference (W6). Its ports are the media functions, the speech connection and the role deps. Absent: not_implemented. */
  analysis?: ReferencePorts;
  /**
   * The picture client (zoom and loop) of the reference readings. With it and without readings in `analysis`, analyze_reference reads
   * captions, shake, speed ramps, zoom and loop through analysisReadings (analyze/frameReader.ts). Absent, the readings stay unknown.
   */
  picture?: PictureClient;
  /** voice (W6). Its ports are the asset router's speech route, the speech connection and the media functions. Absent: not_implemented. */
  voice?: VoiceStagePorts;
  shotPorts?: ShotPorts;
  handlers?: ExternalStageHandlers;
  /** The style kit a validated request names (Bible 13). Absent, the kit store of this database is read. */
  styleKit?: (scope: { organizationId: string; validated: ValidatedRequest }) => Promise<StyleKit | undefined>;
  /** The optional ports of pre_render_gate (budget, licences, product imagery, disclosure). Absent, their checks are not evaluated (fail closed). */
  preRender?: Omit<PreRenderPorts, "loadStyleKit">;
  /** render (Bible 6.11): the HyperFrames and Shotstack deps. Absent, render stays not_implemented and nothing is rendered. */
  render?: RenderPorts;
  /** post_render_review (Bible 6.12): the media, object store and Critic. Absent, it stays not_implemented. */
  postRender?: PostRenderPorts;
  /** variants (Bible 6.13). Absent, the stage runs with no music track connected (none is loaded, so no music variant is built). */
  variants?: VariantPorts;
  /** deliver (Bible 6.14). Absent, the stage reads and writes the engine tables of this database. */
  deliver?: DeliverPorts;
  /**
   * The link a chain input gets for its provider (Bible 10.1), passed to produce_shot with the shot ports. Production:
   * productionProviderUrl (production-ports.ts), which links through Meridian's signer and needs each chain provider's base URL. Absent,
   * a chain's stored uris are sent as they are and the adapters refuse them (fail closed).
   */
  providerUrl?: ProviderUrl;
};

/** The model classes whose adapters can be polled (the router's submit targets). A poll resolves the adapter by its id. */
const POLLABLE_CLASSES: readonly ModelClass[] = ["video.cinematic", "video.budget", "video.i2v_pinned", "avatar", "image.keyframe", "tts", "lipsync"];

/**
 * The adapter that polls a submitted call (Bible 15.2). It is the adapter the router would build for the same route, for the
 * workspace the call belongs to (its credentials are the workspace's). Null when the route is not in the table or the composition
 * has no shot ports (the adapters need the media store and the video profiles).
 */
export function pollAdapterFor(composition: EngineComposition, providerId: string, organizationId: string): ProviderAdapter | null {
  const ports = composition.shotPorts;
  if (ports === undefined) return null;
  for (const modelClass of POLLABLE_CLASSES) {
    for (const route of composition.gateway.routes(modelClass)) {
      if (`${route.provider.id}:${route.model}` !== providerId) continue;
      return adapterFor(route, {
        gateway: composition.gateway,
        organizationId,
        workspaceId: organizationId,
        media: ports.assetMedia,
        videoProfiles: ports.videoProfiles ?? new Map<string, VideoProfile>(),
        voice: null,
        speechSpeed: 1,
      });
    }
  }
  return null;
}

const isoNow = (): string => new Date().toISOString();

/** The Claude client's deps for one request on its reservation: the reservation's lockable ledger and the request's journal. */
function rolesFor(composition: EngineComposition): (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps {
  const now = composition.now ?? isoNow;
  return (scope) => ({
    gateway: composition.gateway,
    ledger: scopedLedgerStore(composition.sql, scope.organizationId, scope.reservationId),
    now,
    journal: sqlRoleCallJournal(composition.sql, { organizationId: scope.organizationId, requestId: scope.requestId }),
  });
}

/** The asset router of one generation job, on the request's reservation (Bible 10). */
function routerFor(composition: EngineComposition, ports: ShotPorts) {
  const now = composition.now ?? isoNow;
  return (scope: { sql: Sql; organizationId: string; requestId: string; reservationId: string }): AsyncAssetRouter =>
    createAssetRouter({
      gateway: composition.gateway,
      ledger: scopedLedgerStore(scope.sql, scope.organizationId, scope.reservationId),
      cache: sqlAssetCache(scope.sql, scope.organizationId),
      stats: sqlProviderStats(scope.sql, scope.organizationId),
      breakers: sqlBreakerStore(scope.sql, scope.organizationId),
      buckets: sqlBucketStore(scope.sql, scope.organizationId),
      media: ports.assetMedia,
      videoProfiles: ports.videoProfiles ?? new Map<string, VideoProfile>(),
      ...(ports.routerSettings === undefined ? {} : { settings: ports.routerSettings }),
      ...(ports.sleep === undefined ? {} : { sleep: ports.sleep }),
      now: () => Date.parse(now()),
    });
}

/**
 * The analyze_reference ports with the frame readings wired (Bible 6.2 step 6, 8.1). When the composition gives a picture client and
 * no readings of its own, the readings are analysisReadings: the picture measures and the frame_reader role on the same roles deps.
 */
export function analysisPortsOf(analysis: ReferencePorts, picture: PictureClient | undefined): ReferencePorts {
  if (analysis.readings !== undefined || picture === undefined) return analysis;
  return { ...analysis, readings: analysisReadings({ picture, roles: analysis.roles }) };
}

/**
 * The ports of produce_shot for a composition with shot ports. The composition's providerUrl (Bible 10.1) is passed on here, so a chain's
 * inputs are linked for the provider that reads them. Absent the providerUrl, the field is absent too (the adapters refuse the stored uris).
 */
export function produceShotPortsOf(composition: EngineComposition, shot: ShotPorts): ProduceShotPorts {
  const now = composition.now ?? isoNow;
  return {
    generator: routerGenerator(routerFor(composition, shot)),
    stock: (input) =>
      searchStock({
        gateway: composition.gateway,
        organizationId: input.organizationId,
        query: input.query,
        minDurationMs: input.minDurationMs,
        providerFor: (route) => stockProviderFor(route, composition.gateway),
      }),
    downloader: gatewayDownloader(composition.gateway),
    media: shot.media,
    objects: shot.objects,
    now: () => Date.parse(now()),
    ...(composition.providerUrl === undefined ? {} : { providerUrl: composition.providerUrl }),
  };
}

/** The runtime for a composition. Each handler is built from the ports it is given, and nothing else is read. */
export function createEngineRuntime(composition: EngineComposition): EngineRuntime {
  const now = composition.now ?? isoNow;
  const runtime: EngineRuntime = {
    handlers: {},
    providers: { resolve: (providerId, organizationId) => pollAdapterFor(composition, providerId, organizationId) },
    now: () => Date.parse(now()),
  };
  const kits = kitPorts(composition.sql);
  const roles = rolesFor(composition);

  const intakePorts: IntakePorts = {
    loadKits: kits.loadKits,
    workspaceBudget: composition.workspaceBudget,
    roleDeps: roles,
    ...(composition.lookupDna === undefined ? {} : { lookupDna: composition.lookupDna }),
  };
  const handlers: Parameters<typeof registerEngineHandlers>[1] = {
    intake: createIntakeHandler(intakePorts),
    plan: createPlanHandler({ loadKits: kits.loadKits, roleDeps: roles }),
    estimate_reserve: createEstimateReserveHandler({ workspaceBudget: composition.workspaceBudget }),
    edit: createEditHandler({ loadStyleKit: kits.loadStyleKit }),
  };

  if (composition.analysis !== undefined) {
    handlers.analyze_reference = createAnalyzeReferenceHandler(analysisPortsOf(composition.analysis, composition.picture));
  }
  if (composition.voice !== undefined) handlers.voice = createVoiceHandler(composition.voice);

  // Stages 9 to 14 that need no model call or provider are registered on the kits and the engine tables (E4, E5).
  const styleKitOf = composition.styleKit ?? kits.loadStyleKit;
  handlers.pre_render_gate = createPreRenderGateHandler({ ...(composition.preRender ?? {}), loadStyleKit: styleKitOf });
  handlers.compose = createComposeHandler({ loadStyleKit: styleKitOf, now: () => now() });
  handlers.variants = createVariantsHandler(
    composition.variants ?? {
      // No music track is connected, so the matrix's music ids name no track and no music variant is built (fail closed).
      loadMusicTrack: async () => undefined,
      withLedger: (scope, fn) => withReservationLedger(composition.sql, scope.organizationId, scope.reservationId, fn),
      events: sqlEventStore(composition.sql),
      now,
      loadStyleKit: styleKitOf,
    },
  );
  handlers.deliver = createDeliverHandler(
    composition.deliver ?? {
      withLedger: (scope, fn) => withReservationLedger(composition.sql, scope.organizationId, scope.reservationId, fn),
      roleCalls: (scope) => listRoleCalls(composition.sql, scope),
      gates: (scope) => gateResultsOf(composition.sql, scope),
      decisions: (scope) => decisionsOf(composition.sql, scope),
      events: sqlEventStore(composition.sql),
      now,
    },
  );
  if (composition.render !== undefined) handlers.render = createRenderHandler(composition.render);
  if (composition.postRender !== undefined) handlers.post_render_review = createPostRenderReviewHandler(composition.postRender);

  const shot = composition.shotPorts;
  if (shot !== undefined) {
    const checkPorts: CheckTakePorts = {
      gateway: composition.gateway,
      media: shot.media,
      objects: shot.objects,
      now,
      ...(shot.similarity === undefined ? {} : { scorer: shot.similarity }),
      ...(shot.detectors === undefined ? {} : { detectors: shot.detectors }),
    };
    handlers.produce_shot = createProduceShotHandler(produceShotPortsOf(composition, shot));
    handlers.check_take = createCheckTakeHandler(checkPorts);
  }

  registerEngineHandlers(runtime, { ...handlers, ...(composition.handlers ?? {}) });
  return runtime;
}

const productionRuntimes = new WeakMap<Sql, EngineRuntime>();

/**
 * The seams of the production composition. Production passes none: the gateway reads Meridian's credentials and sends over the
 * gateway's own fetch, and the signer reads the server's secret and origin. A test passes its own gateway or signer, nothing else.
 */
export type ProductionDeps = {
  gateway?: Gateway;
  mediaLinks?: MediaLinkSigner;
};

/**
 * The composition Meridian's production runtime is built from. Every network call goes through the gateway, every key comes from its
 * credential source, and every link comes from the signer. The chain's providerUrl (Bible 10.1) is the production one: a chain input is
 * linked through the signer, and a chain provider with no base URL on this deployment is NOT_CONNECTED with its reason.
 */
export function productionComposition(sql: Sql, deps: ProductionDeps = {}): EngineComposition {
  const gateway = deps.gateway ?? createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
  const mediaLinks = deps.mediaLinks ?? engineMediaLinkSigner();
  // The render and post-render deps (owner decision 2026-10-14): HyperFrames and Shotstack through the gateway, the engine's objects in
  // Meridian's store, and the 15-minute source links signed by Meridian. Each is fail closed on its own (NOT_CONNECTED, price unknown).
  const objects = engineObjectStore(sql);
  const media = gatewayMediaFunctions(gateway);
  const workspaceBudget = workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql));
  return {
    sql,
    gateway,
    workspaceBudget,
    render: productionRenderPorts({ sql, gateway, objects, media, mediaLinks, now: isoNow }),
    postRender: productionPostRenderPorts({ gateway, media, objects, now: isoNow }),
    providerUrl: productionProviderUrl({ gateway, mediaLinks }),
  };
}

/**
 * The runtime Meridian's worker uses (lib/meridian/jobs/execute.ts). Its gateway takes its keys from Meridian's credential resolver
 * and its transport is the gateway's own fetch. Only the stages that have every port they need are registered; see the header.
 * One runtime per database handle.
 */
export function productionEngineRuntime(sql: Sql): EngineRuntime {
  const existing = productionRuntimes.get(sql);
  if (existing) return existing;
  const composition = productionComposition(sql);
  // The variants stage (Bible 6.13): the writer over the gateway, the kits and the month budget. Its voice is not connected in production,
  // so a variant that needs one is NOT_CONNECTED with its reason and no call is made (variants/STATUS.md).
  const runtime = createEngineRuntime({
    ...composition,
    variants: productionVariantPorts({
      sql,
      gateway: composition.gateway,
      roles: rolesFor(composition),
      workspaceBudget: composition.workspaceBudget,
      loadStyleKit: kitPorts(sql).loadStyleKit,
      now: isoNow,
    }),
  });
  productionRuntimes.set(sql, runtime);
  return runtime;
}
