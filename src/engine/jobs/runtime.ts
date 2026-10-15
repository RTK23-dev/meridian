// The engine runtime's composition root (Bible 5.1, E3 lead decision 7). It takes the database, the gateway and the stores, and
// registers every stage handler that is built. A stage with no handler stays not_implemented, so the dispatcher refuses it and
// never marks it done. Meridian's worker runs engine jobs with productionEngineRuntime(sql) (lib/meridian/jobs/execute.ts).
//
// What is registered, and what is not (E3 status, see STATUS.md):
//   - always: intake, plan, estimate_reserve, edit. They need the database, the gateway (for the Claude roles), the kits and the
//     workspace's monthly budget (Meridian's Settings, through workspaceBudgetFromSettings).
//   - with shotPorts: produce_shot and check_take. Their media functions, object store and asset-media store are deployment
//     wiring that does not exist yet, so production does not register them. They stay not_implemented, which fails closed.
//   - with handlers: analyze_reference, voice (W6) and render (W10). Those stages are built in other workstreams; they are
//     registered when the composition is given them, and not otherwise.
//   - never here: compose, pre_render_gate, post_render_review, variants, deliver. They are not built.
//
// No key is read here: the gateway takes its credentials from Meridian's resolver, and the transport is the gateway's own.

import { createAssetRouter, type AssetRouter, type RouterSettings } from "../assets/router.ts";
import type { MediaStore } from "../assets/adapter.ts";
import type { VideoProfile } from "../assets/providers/openrouterVideo.ts";
import { stockProviderFor } from "../assets/providers/index.ts";
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
import { createProduceShotHandler, routerGenerator } from "./handlers/produce-shot.ts";
import { registerEngineHandlers } from "./handlers/register.ts";
import { kitPorts } from "./kit-store.ts";
import type { MediaStorePort } from "./artifact-store.ts";
import type { EngineRuntime, StageHandler } from "./types.ts";

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
  shotPorts?: ShotPorts;
  handlers?: ExternalStageHandlers;
};

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
  return (scope: { sql: Sql; organizationId: string; requestId: string; reservationId: string }): AssetRouter =>
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

/** The runtime for a composition. Each handler is built from the ports it is given, and nothing else is read. */
export function createEngineRuntime(composition: EngineComposition): EngineRuntime {
  const now = composition.now ?? isoNow;
  const runtime: EngineRuntime = {
    handlers: {},
    providers: { resolve: () => null },
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

  const shot = composition.shotPorts;
  if (shot !== undefined) {
    const checkPorts: CheckTakePorts = {
      gateway: composition.gateway,
      media: shot.media,
      objects: shot.objects,
      now,
      ...(shot.similarity === undefined ? {} : { scorer: shot.similarity }),
    };
    handlers.produce_shot = createProduceShotHandler({
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
    });
    handlers.check_take = createCheckTakeHandler(checkPorts);
  }

  registerEngineHandlers(runtime, { ...handlers, ...(composition.handlers ?? {}) });
  return runtime;
}

const productionRuntimes = new WeakMap<Sql, EngineRuntime>();

/**
 * The runtime Meridian's worker uses (lib/meridian/jobs/execute.ts). Its gateway takes its keys from Meridian's credential resolver
 * and its transport is the gateway's own fetch. Only the stages that have every port they need are registered; see the header.
 * One runtime per database handle.
 */
export function productionEngineRuntime(sql: Sql): EngineRuntime {
  const existing = productionRuntimes.get(sql);
  if (existing) return existing;
  const runtime = createEngineRuntime({
    sql,
    gateway: createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() }),
    workspaceBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
  });
  productionRuntimes.set(sql, runtime);
  return runtime;
}
