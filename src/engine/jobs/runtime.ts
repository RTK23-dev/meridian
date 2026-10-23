// The engine runtime's composition root (Bible 5.1, E3 lead decision 7). It takes the database, the gateway and the stores, and
// registers every stage handler that is built. A stage with no handler stays not_implemented, so the dispatcher refuses it and
// never marks it done. Meridian's worker runs engine jobs with productionEngineRuntime(sql) (lib/meridian/jobs/execute.ts).
//
// What is registered, and what is not (E3 status, see STATUS.md):
//   - always: intake, plan, estimate_reserve, edit. They need the database, the gateway (for the Claude roles), the kits and the
//     workspace's monthly budget (Meridian's Settings, through workspaceBudgetFromSettings).
//   - with shotPorts: produce_shot and check_take. Production always gives them (productionComposition): the media functions
//     (MEDIA_FUNCTIONS_BASE_URL, read outside src/engine), the engine's object store (Drive), the request-bound asset store and the
//     video profiles from GET /videos/models (assets/video-profiles.ts). Before any paid call, shotConnection names what is not
//     connected (the media functions, Drive), and a video class with no eligible model is refused with the listing's reasons. A
//     composition with no shotPorts keeps both stages not_implemented, which fails closed. The chain's providerUrl (Bible 10.1) is
//     built by productionComposition from the gateway's base URLs and Meridian's signer. A chain provider with no base URL makes
//     that link NOT_CONNECTED with its reason (jobs/STATUS.md).
//   - with their ports: analyze_reference (the `analysis` ports), write_script (the `writeScript` ports, contract v8) and voice (the
//     `voice` ports). Without ports each stays not_implemented. Production gives all three (productionComposition, production-stages.ts):
//     analyze_reference reads the uploaded reference from Meridian's store (store:// uris) as bytes, through the media functions and the speech ports;
//     write_script writes a brief's script with the scriptwriter; voice speaks through the asset router's speech route. Each is fail closed
//     on its own: a brief's reference is transcribed with the vendor's language detection (lead decision 2026-10-17), the speech output is MP3
//     and the engine stores it, and a speech call's bill is read once from the generation stats (unsettled on a miss). A composition may
//     also pass a handler for render (W10) through `handlers`.
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
import { isVideoClass, type VideoProfile } from "../assets/providers/openrouterVideo.ts";
import { adapterFor, stockProviderFor } from "../assets/providers/index.ts";
import { EngineError, type ModelClass, type ProviderAdapter } from "../contracts/index.ts";
import { noEligibleVideoModel, videoProfileLoader, type VideoProfileLoader } from "../assets/video-profiles.ts";
import { createAnalyzeReferenceHandler, type ReferencePortsFor } from "./handlers/analyze-reference.ts";
import { createVoiceHandler, type VoicePortsFor, type VoiceStagePorts } from "./handlers/voice.ts";
import { createWriteScriptHandler, type WriteScriptPorts } from "./handlers/write-script.ts";
import { productionAnalysisPortsFor, productionReferenceSource, productionVoicePortsFor } from "./production-stages.ts";
import { engineReferenceStore } from "../../lib/meridian/storage/engine-reference-store.ts";
import type { ReferencePorts } from "../analyze/reference.ts";
import { analysisReadings } from "../analyze/frameReader.ts";
import { deepgramBillReader, deepgramForRoute, deepgramProjects, speechPortsOf, type MediaFunctionsMode, type PictureClient, type SpeechPorts } from "../media/index.ts";
import { reconcileHolds, type BillReader } from "../budget/reconcile-holds.ts";
import { openRouterGenerationBill } from "../gateway/generation.ts";
import type { HttpMediaFunctions } from "../media/http.ts";
// The one production file outside src/engine/media that imports the in-process media functions (boundaries.test.ts): the composition
// root chooses them when MEDIA_FUNCTIONS_MODE=in_process (owner decision 2026-10-16).
import { inProcessMediaFunctions } from "../media/local.ts";
import type { TakeDetectors } from "./gate-measures.ts";
import {
  brandOfRequest,
  gatewayMediaFunctions,
  productionPostRenderPorts,
  productionProviderUrl,
  productionRenderPorts,
  productionShotConnection,
  productionVariantPorts,
  type ProviderUrl,
  type ShotConnection,
} from "./production-ports.ts";
import { engineMediaLinkSigner, engineObjectStore } from "../../lib/meridian/storage/engine-media-link.ts";
import { engineAssetMediaFor } from "../../lib/meridian/storage/engine-asset-media.ts";
import { engineMediaFunctionsBaseUrl, engineMediaFunctionsMode } from "../../lib/meridian/storage/engine-media-functions.ts";
import { engineLicensedProviders } from "../../lib/meridian/storage/engine-licences.ts";
import { licensedProvidersOf, licensedUrisOf } from "./licensed-uris.ts";
import type { MediaLinkSigner } from "./media-link.ts";
import { searchStock } from "../assets/stock.ts";
import { createGateway, type Gateway } from "../gateway/gateway.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import { modelCatalogCache, type ModelCatalogSource } from "../gateway/catalog.ts";
import { withModelPolicy } from "../gateway/catalog-policy.ts";
import { readOrchestratorPolicy } from "../orchestrator/policy-store.ts";
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
import { createProduceShotHandler, routerGenerator, type ProduceShotPorts, type ShotGenerator } from "./handlers/produce-shot.ts";
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
import { pollAssetJobs, sqlAssetPollStore } from "../orchestrator/asset-poll.ts";

/** The stages built in other workstreams (W6: analyze_reference and voice; W10: render). Registered only when given. */
export type ExternalStageHandlers = Partial<Record<"analyze_reference" | "voice" | "render", StageHandler>>;

/** The ports the two generation stages need. All of them are required together, or the stages are not registered. */
export type ShotPorts = {
  media: Pick<MediaFunctions, "probe" | "frames">;
  /** The object store the takes' media is written to (Bible 5.2). */
  objects: MediaStorePort;
  /**
   * The asset router's store for image and speech bytes, for a shot with no request scope (tests). Polls take it too: a poll writes no
   * bytes. Production gives assetMediaFor instead, and this store refuses every write.
   */
  assetMedia: MediaStore;
  /**
   * The asset store of one request (Bible 5.2). Its keys name the request and the bytes go under its brand, so the router writes through
   * the store of the call's own request. Production: engineAssetMediaFor over the engine's object store. When given, it is used instead
   * of assetMedia.
   */
  assetMediaFor?: (scope: { organizationId: string; requestId: string }) => MediaStore;
  /**
   * The video models' profiles, loaded from GET /videos/models for one workspace and cached per runtime (assets/video-profiles.ts). A
   * model the listing does not name, or a listing that failed, leaves it out with its reason, and produce_shot refuses a video shot with
   * those reasons. Absent: no video model is eligible, and produce_shot says so.
   */
  videoProfiles?: VideoProfileLoader;
  /**
   * OpenRouter's model catalog, cached per runtime (gateway/catalog.ts, Bible 10.5). The router checks a spec's modelChoice against it
   * and estimates the chosen model from its price. Absent, a spec with a choice is routed by the route table, with a decision saying so.
   */
  catalog?: ModelCatalogSource;
  /**
   * The reason the shot ports cannot make or store a take for this workspace, or null when they can. It is checked before any paid call
   * (produce_shot's generate, check_take's read). Production: productionShotConnection (media functions and Drive connected). Absent,
   * nothing is checked, which is for tests with fake ports only.
   */
  shotConnection?: ShotConnection;
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
  /**
   * The asset router of one orchestrator run (production: the same router the production stages use, on the run's own reservation). The
   * orchestrator's visual and voice steps make their asset through it (orchestrator/production.ts). Absent without shot ports: those steps
   * then report not_connected.
   */
  assetRouter?: (scope: { organizationId: string; requestId: string; reservationId: string }) => AsyncAssetRouter;
  /** The workspace's monthly budget (Bible 14.1 step 2). Production: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)). */
  workspaceBudget: WorkspaceBudgetSource;
  /** The clock as an ISO time (ledger entries, artifacts). Defaults to the wall clock. */
  now?: () => string;
  /** The VideoDNA lookup (Bible 6.1 step 5). Absent, intake fails its dna_lookup check: no lookup is made and nothing is assumed. */
  lookupDna?: IntakePorts["lookupDna"];
  /**
   * analyze_reference (W6). Its ports are the media functions, the speech connection and the role deps. A function of the job's reservation
   * gives them per job (production: the ledger and the Claude deps are per reservation). Absent: not_implemented.
   */
  analysis?: ReferencePorts | ReferencePortsFor;
  /** The media functions (probe, cuts, frames, timeline, loudness, picture). Production: the in-process or the HTTP form (productionComposition). */
  media?: MediaFunctions;
  /**
   * The picture client (zoom and loop) of the reference readings. With it and without readings in `analysis`, analyze_reference reads
   * captions, shake, speed ramps, zoom and loop through analysisReadings (analyze/frameReader.ts). Absent, the readings stay unknown.
   */
  picture?: PictureClient;
  /**
   * voice (W6). Its ports are the asset router's speech route, the speech connection and the media functions. A function of the job's
   * reservation gives them per job. Absent: not_implemented.
   */
  voice?: VoiceStagePorts | VoicePortsFor;
  /**
   * write_script (contract v8): the scriptwriter over the Claude deps and the kit store. Absent: not_implemented, so a brief request stops
   * at write_script, and a script request never reaches it.
   */
  writeScript?: WriteScriptPorts;
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
  /**
   * The speech-to-text ports (media/stt-connection.ts): the connection, which resolves the stt route to the Deepgram adapter, and the
   * route's list price per minute. The analyze_reference and voice ports take these two values. Absent, nothing is speech-ready.
   */
  speech?: SpeechPorts;
  /**
   * The bill readers of held calls, by provider (contract v9): the reconcile_holds maintenance job settles a held call from its bill
   * through them (budget/reconcile-holds.ts). Production: OpenRouter's generation stats and Deepgram's request lookup. Absent, the job is not
   * implemented, so no held call is read or settled.
   */
  holdReaders?: Partial<Record<string, BillReader>>;
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
      // A poll reads no profile (the video poll is by job id) and writes no bytes, so the profiles are empty and the store is unbound.
      return adapterFor(route, {
        gateway: composition.gateway,
        organizationId,
        workspaceId: organizationId,
        media: ports.assetMedia,
        videoProfiles: new Map<string, VideoProfile>(),
        voice: null,
        voiceProvider: null,
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

/**
 * The asset router of one generation job, on the request's reservation (Bible 10). The profiles are the ones the caller loaded for the
 * job's workspace. The store is the request's own when the shot ports give one (assetMediaFor), so a keyframe's key names the request.
 */
function routerFor(composition: EngineComposition, ports: ShotPorts, profiles: ReadonlyMap<string, VideoProfile>) {
  const now = composition.now ?? isoNow;
  return (scope: { sql: Sql; organizationId: string; requestId: string; reservationId: string }): AsyncAssetRouter =>
    createAssetRouter({
      gateway: composition.gateway,
      ledger: scopedLedgerStore(scope.sql, scope.organizationId, scope.reservationId),
      cache: sqlAssetCache(scope.sql, scope.organizationId),
      stats: sqlProviderStats(scope.sql, scope.organizationId),
      breakers: sqlBreakerStore(scope.sql, scope.organizationId),
      buckets: sqlBucketStore(scope.sql, scope.organizationId),
      media: ports.assetMediaFor?.({ organizationId: scope.organizationId, requestId: scope.requestId }) ?? ports.assetMedia,
      videoProfiles: profiles,
      ...(ports.catalog === undefined ? {} : { catalog: ports.catalog }),
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
 * The asset store of a shot with no request scope. Production binds one per request (assetMediaFor), so this store refuses every write:
 * a shot that reaches it is refused with its reason, and nothing is stored.
 */
export const UNBOUND_ASSET_MEDIA: MediaStore = {
  async put() {
    throw new EngineError("config", "the asset store is not bound to a request, so no bytes are stored");
  },
};

/**
 * The generator of produce_shot (Bible 10.1, 10.4, 14). A generate call is made only when its take can be stored and priced:
 *   1. the shot ports are connected for the workspace (shotConnection: the media functions and the workspace's Drive, production);
 *   2. a video class has a routed OpenRouter model with a verified profile (videoProfiles); otherwise the refusal names each model's
 *      reason, from the listing, and no call is made;
 *   3. the request has a brand, so its media has a place to be stored (checked before the paid call, not after it).
 * A refusal at 1 or 2 returns not_connected with its reasons, which produce_shot turns into a NOT_CONNECTED failure of the shot. A settle
 * makes no new paid call; it reads the profiles only, in case the router moves the call to another target of the same class.
 * Image and speech classes never read the video listing, so an image shot does not depend on it.
 */
export function shotGeneratorOf(composition: EngineComposition, shot: ShotPorts): ShotGenerator {
  const loader = shot.videoProfiles;
  const profilesFor = async (organizationId: string, modelClass: string): Promise<ReadonlyMap<string, VideoProfile>> =>
    loader === undefined || !isVideoClass(modelClass) ? new Map<string, VideoProfile>() : loader.loadVideoProfiles(organizationId);
  return {
    async generate(input) {
      const blocked = shot.shotConnection === undefined ? null : await shot.shotConnection(input.organizationId);
      if (blocked !== null) return { status: "not_connected", reasons: [blocked] };
      const profiles = await profilesFor(input.organizationId, input.spec.modelClass);
      // A spec with a model choice (Bible 10.5) is checked by the router against the catalog, which has the chosen model's own profile;
      // the route table's profiles do not decide it. If the choice cannot be used, the router's route-table targets refuse it the same way.
      const refusal =
        input.spec.modelChoice !== null
          ? null
          : noEligibleVideoModel({
              modelClass: input.spec.modelClass,
              profiles,
              gaps: loader?.gapsFor(input.organizationId) ?? [],
            });
      if (refusal !== null) return { status: "not_connected", reasons: refusal };
      await brandOfRequest(input.sql, input.organizationId, input.requestId);
      return routerGenerator(routerFor(composition, shot, profiles)).generate(input);
    },
    async settle(input, job, polled) {
      const profiles = await profilesFor(input.organizationId, job.modelClass);
      return routerGenerator(routerFor(composition, shot, profiles)).settle(input, job, polled);
    },
  };
}

/**
 * The ports of produce_shot for a composition with shot ports. The composition's providerUrl (Bible 10.1) is passed on here, so a chain's
 * inputs are linked for the provider that reads them. Absent the providerUrl, the field is absent too (the adapters refuse the stored uris).
 */
export function produceShotPortsOf(composition: EngineComposition, shot: ShotPorts): ProduceShotPorts {
  const now = composition.now ?? isoNow;
  return {
    generator: shotGeneratorOf(composition, shot),
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

/** A stage handler that checks its shot ports are connected before it runs. A missing connection is a config error with its reason. */
function connectedFirst(handler: StageHandler, stage: string, connection: ShotConnection): StageHandler {
  return {
    ...handler,
    async run(ctx) {
      const reason = await connection(ctx.organizationId);
      if (reason !== null) throw new EngineError("config", reason, { stage, retryable: false });
      return handler.run(ctx);
    },
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
  if (composition.holdReaders !== undefined) {
    // The reconcile_holds maintenance job (contract v9): settles the workspace's held calls whose bills can now be read. It names no
    // stage, so it is dispatched as a maintenance job (dispatch.ts) and not as a stage handler.
    const readers = composition.holdReaders;
    runtime.jobs = {
      reconcile_holds: {
        run: async (ctx) => {
          const held = await reconcileHolds(ctx.sql, { organizationId: ctx.organizationId, now: runtime.now(), readers });
          return `reconciled:settled=${held.settled.count},open=${held.stillOpen.count},operator=${held.needsOperator.count}`;
        },
      },
    };
  }
  // The asset poll (engine.asset_poll): settles the orchestrator's queued video and avatar submits once their provider has finished. It
  // needs the composition's asset router, which production always has.
  const routerFor = composition.assetRouter;
  if (routerFor !== undefined) {
    runtime.jobs = {
      ...runtime.jobs,
      asset_poll: {
        run: async (ctx) => {
          const report = await pollAssetJobs({
            store: sqlAssetPollStore(ctx.sql, ctx.organizationId),
            organizationId: ctx.organizationId,
            routerFor,
          });
          return `polled:${report.polled}:done:${report.done}:failed:${report.failed}:waiting:${report.waiting}`;
        },
      },
    };
  }
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
    // The model choice after the plan (Bible 10.5) reads the same catalog cache the routers check the choices against.
    plan: createPlanHandler({
      loadKits: kits.loadKits,
      roleDeps: roles,
      ...(composition.shotPorts?.catalog === undefined ? {} : { catalog: composition.shotPorts.catalog }),
    }),
    estimate_reserve: createEstimateReserveHandler({
      workspaceBudget: composition.workspaceBudget,
      ...(composition.shotPorts?.catalog === undefined ? {} : { catalog: composition.shotPorts.catalog }),
    }),
    edit: createEditHandler({ loadStyleKit: kits.loadStyleKit }),
  };

  if (composition.analysis !== undefined) {
    // A fixed ReferencePorts serves every job (tests); a function gives each job its own (production: per reservation).
    const analysis = composition.analysis;
    const portsFor: ReferencePortsFor = typeof analysis === "function" ? analysis : () => analysis;
    handlers.analyze_reference = createAnalyzeReferenceHandler((scope) => analysisPortsOf(portsFor(scope), composition.picture));
  }
  if (composition.writeScript !== undefined) handlers.write_script = createWriteScriptHandler(composition.writeScript);
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
    const checkTake = createCheckTakeHandler(checkPorts);
    handlers.check_take = shot.shotConnection === undefined ? checkTake : connectedFirst(checkTake, "check_take", shot.shotConnection);
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
  /** A gateway a test builds. Given, the media functions' URL is the gateway's own; production builds the gateway (below). */
  gateway?: Gateway;
  mediaLinks?: MediaLinkSigner;
  /** The engine's object store. Production: engineObjectStore(sql), Meridian's Drive-backed store. */
  objects?: MediaStorePort;
  /**
   * The media functions' base URL for a gateway built here. Production reads MEDIA_FUNCTIONS_BASE_URL (engine-media-functions.ts); null
   * leaves the media functions NOT_CONNECTED. Ignored when a gateway is given.
   */
  mediaFunctionsBaseUrl?: string | null;
  /**
   * The media functions' mode (MEDIA_FUNCTIONS_MODE). Production reads it (engine-media-functions.ts); a test passes its own. "in_process"
   * runs the ffmpeg handlers in this process, and "http" calls the functions through the gateway.
   */
  mediaFunctionsMode?: MediaFunctionsMode;
};

/**
 * The composition Meridian's production runtime is built from. Every network call goes through the gateway, every key comes from its
 * credential source, and every link comes from the signer. The chain's providerUrl (Bible 10.1) is the production one: a chain input is
 * linked through the signer, and a chain provider with no base URL on this deployment is NOT_CONNECTED with its reason.
 */
export function productionComposition(sql: Sql, deps: ProductionDeps = {}): EngineComposition {
  // The media functions' base URL is a deployment setting (MEDIA_FUNCTIONS_BASE_URL), read here, outside src/engine. Unset, the media
  // functions are NOT_CONNECTED with the gateway's reason, and so is every stage that needs them.
  const mediaFunctionsBaseUrl = deps.mediaFunctionsBaseUrl === undefined ? engineMediaFunctionsBaseUrl() : deps.mediaFunctionsBaseUrl;
  const gateway =
    deps.gateway ??
    createGateway({
      transport: fetchHttpTransport,
      credentials: meridianCredentialSource(),
      providers: mediaFunctionsBaseUrl === null ? {} : { media_functions: { baseUrl: mediaFunctionsBaseUrl } },
    });
  const mediaLinks = deps.mediaLinks ?? engineMediaLinkSigner();
  // The render and post-render deps (owner decision 2026-10-14): HyperFrames and Shotstack through the gateway, the engine's objects in
  // Meridian's store, and the 15-minute source links signed by Meridian. Each is fail closed on its own (NOT_CONNECTED, price unknown).
  const objects = deps.objects ?? engineObjectStore(sql);
  // The media functions: in the in-process mode the ffmpeg handlers run in this process (the worker's image installs ffmpeg), and
  // there is no base URL to check. In the http mode they are called through the gateway, NOT_CONNECTED without a base URL.
  const mediaFunctionsMode = deps.mediaFunctionsMode === undefined ? engineMediaFunctionsMode() : deps.mediaFunctionsMode;
  const media: HttpMediaFunctions = mediaFunctionsMode === "in_process" ? inProcessMediaFunctions() : gatewayMediaFunctions(gateway);
  // The speech-to-text vendor (owner decision 2026-10-16): Deepgram for the stt route. The project of each workspace is named once per
  // process from GET /v1/projects (cached per workspace), and a call's workspace comes from the request.
  const projects = deepgramProjects(gateway);
  const speech = speechPortsOf(gateway, { resolve: (route) => deepgramForRoute(route, { gateway, projects }) });
  const workspaceBudget = workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql));
  // The shot ports (Bible 6.6, 6.7): the take and image stores under each request's brand, the video profiles of the listing, and the
  // connection check that refuses a shot before any paid call when the media functions or the workspace's Drive are not connected.
  const shotPorts: ShotPorts = {
    media,
    objects,
    assetMedia: UNBOUND_ASSET_MEDIA,
    assetMediaFor: (scope) =>
      engineAssetMediaFor(
        { objects, brandOf: ({ organizationId, requestId }) => brandOfRequest(sql, organizationId, requestId) },
        { organizationId: scope.organizationId, requestId: scope.requestId },
      ),
    videoProfiles: videoProfileLoader({ gateway }),
    catalog: withModelPolicy(modelCatalogCache({ gateway }), async (organizationId) => (await readOrchestratorPolicy(sql, organizationId)).disabledModelFamilies),
    shotConnection: productionShotConnection({ sql, gateway, mediaFunctionsMode }),
  };
  // The analysis, voice and write_script ports (Bible 6.2, 6.3; contract v8). Their Claude deps and asset router are per reservation, so
  // they are built from the composition, lazily: each call reads the composition's gateway, clock and stores for its own job.
  const referenceSource = productionReferenceSource({ sql, store: engineReferenceStore(sql) });
  const composition: EngineComposition = {
    sql,
    gateway,
    workspaceBudget,
    media,
    picture: media.picture,
    // The bill readers of held calls (contract v9). A call's providerRef is the OpenRouter generation id, or the Deepgram request id.
    holdReaders: {
      openrouter: (input) => openRouterGenerationBill(gateway, { organizationId: input.organizationId, generationId: input.providerRef }),
      deepgram: deepgramBillReader({ gateway, projects }),
    },
    render: productionRenderPorts({ sql, gateway, objects, media, mediaLinks, now: isoNow }),
    postRender: productionPostRenderPorts({ gateway, media, objects, now: isoNow }),
    providerUrl: productionProviderUrl({ gateway, mediaLinks }),
    shotPorts,
    speech,
    analysis: productionAnalysisPortsFor({
      media,
      speech,
      roles: (scope) => rolesFor(composition)(scope),
      source: referenceSource,
    }),
    writeScript: {
      loadKits: kitPorts(sql).loadKits,
      roleDeps: (scope) => rolesFor(composition)(scope),
    },
    assetRouter: (scope) => routerFor(composition, shotPorts, new Map<string, VideoProfile>())({ sql, ...scope }),
    // The rights check reads the licence record of each take and voice track (review 2026-10-22 production licence port). The deployment's
    // list names the providers whose outputs are licensed; unset, only reviewer clips pass and the check fails closed.
    preRender: {
      licensedUris: async (scope) => licensedUrisOf(sql, { organizationId: scope.organizationId, requestId: scope.requestId, licensedProviders: licensedProvidersOf(engineLicensedProviders()) }),
    },
    voice: productionVoicePortsFor({
      sql,
      objects,
      media,
      speech,
      roles: (scope) => rolesFor(composition)(scope),
      router: (scope) => routerFor(composition, shotPorts, new Map<string, VideoProfile>())({ sql, ...scope }),
    }),
  };
  return composition;
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
