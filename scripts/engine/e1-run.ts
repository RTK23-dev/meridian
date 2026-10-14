// The E1 acceptance run (Bible section 19, E1), the same for a dry run and a live run. For each master:
//   1. the request row and its production request artifact (the backend);
//   2. reserve() in cap mode, with the estimate of the hand-written EDL's plan (budget/);
//   3. the budget and EDL artifacts, then compile() to a HyperFrames composition (compose/);
//   4. renderComposition() through the HeyGen cloud adapter, with the gateway's transport and secret (render/);
//   5. the render-integrity check: the media functions probe the downloaded bytes, checkRenderIntegrity judges them (media/);
//   6. releaseReservation() returns the unspent part, the ledger is read back, and the checks are written into the report.
// Nothing here fetches, reads a key or reads the environment. The gateway, the backend and the options are injected.

import { EngineError, newId, type ArtifactEnvelope, type EditDecisionList, type GateResult, type RenderedVideo, type Composition, type BudgetReservation } from "../../src/engine/contracts/index.ts";
import { reserve } from "../../src/engine/budget/reserve.ts";
import { releaseReservation } from "../../src/engine/budget/reconcile.ts";
import { budgets } from "../../src/engine/config/budgets.ts";
import { compile } from "../../src/engine/compose/compiler.ts";
import {
  HyperframesCloudAdapter,
  renderComposition,
  type IntegrityInput,
  type RenderAdapter,
  type RenderOutcome,
} from "../../src/engine/render/hyperframesCloud.ts";
import {
  checkRenderIntegrity,
  httpMediaFunctions,
  integrityLimitsFromConfig,
  type HttpMediaFunctions,
  type MediaSource,
  type ProbeResult,
} from "../../src/engine/media/index.ts";
import { mediaKey } from "../../src/engine/jobs/artifact-store.ts";
import { textTransport, type Gateway } from "../../src/engine/gateway/index.ts";
import { FFMPEG_LIMITS } from "../../functions/ffmpeg/limits.ts";
import { buildE1Edl, buildE1Plan, buildE1Request, e1StyleKit } from "./e1-build.ts";
import type { E1Backend } from "./e1-backend.ts";

export const E1_REPORT_SCHEMA = "meridian.e1_acceptance/v1";
const TITLE = "meridian-e1-acceptance";

export type RunOptions = {
  mode: "dry-run" | "live";
  organizationId: string;
  brandId: string;
  count: number;
  requestBudgetUsd: number;
  workspaceMonthBudgetUsd: number;
  /** The platform's file-size limit for the integrity check. Its source is named in the report. */
  platformMaxBytes: number;
  platformMaxBytesSource: string;
  stockUri: string;
  voiceUri: string;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  provenance: string;
};

export type RunPorts = { gateway: Gateway; backend: E1Backend };

export type LedgerLine = {
  entryId: string;
  stage: string;
  provider: string;
  model: string;
  estimateUsd: number;
  reservedUsd: number;
  actualUsd: number | null;
  actualIsEstimate: boolean | null;
  idempotencyKey: string;
};

export type MasterReport = {
  index: number;
  requestId: string;
  reservationId: string | null;
  edlId: string;
  compositionId: string | null;
  /** The composition hash: the render's Idempotency-Key and the ledger key. */
  idempotencyKey: string | null;
  renderId: string | null;
  videoId: string | null;
  uri: string | null;
  artifactIds: {
    productionRequest: string | null;
    budgetReservation: string | null;
    edl: string | null;
    composition: string | null;
    gateResult: string | null;
    renderedVideo: string | null;
  };
  cost: {
    /** The reservation's estimate of the whole master (its fixed lines; stock and components are $0). */
    estimateUsd: number | null;
    /** What the reservation held when it was made. */
    reservedUsd: number | null;
    /** The render line of the estimate: what the render call was authorized for. */
    renderEstimateUsd: number | null;
    /** Sum of the ledger's actuals. Null unless every entry has one. */
    actualUsd: number | null;
    /** True when the actual is a list-price or held estimate, not a provider bill. */
    actualIsEstimate: boolean | null;
    /** What releaseReservation handed back (the unspent part of the hold). */
    releasedUsd: number | null;
    /** The reservation's amount after release: the committed part. */
    finalReservedUsd: number | null;
  };
  ledger: LedgerLine[];
  probe: ProbeResult | null;
  integrity: { pass: boolean; checks: GateResult["checks"] } | null;
  checks: Record<string, boolean>;
  failure: string | null;
  pass: boolean;
};

export type E1Report = {
  schema: typeof E1_REPORT_SCHEMA;
  mode: RunOptions["mode"];
  backend: string;
  provenance: string;
  organizationId: string;
  brandId: string;
  count: number;
  budgets: { requestUsd: number; workspaceMonthUsd: number };
  platformMaxBytes: { value: number; source: string };
  startedAt: string;
  finishedAt: string;
  masters: MasterReport[];
  totals: {
    masters: number;
    passed: number;
    estimateUsd: number;
    reservedUsd: number;
    renderEstimateUsd: number;
    actualUsd: number | null;
    releasedUsd: number;
  };
  /** False: the render adapter reads no bill from HeyGen, so each actual is the list estimate. The owner checks the invoice. */
  billVerified: false;
  notes: string[];
  pass: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function describeError(error: unknown): string {
  if (error instanceof EngineError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function sumOrNull(values: (number | null | undefined)[]): number | null {
  if (values.some((value) => value === null || value === undefined)) return null;
  return Math.round(values.reduce<number>((total, value) => total + (value as number), 0) * 10_000) / 10_000;
}

function emptyMaster(index: number, requestId: string, edlId: string): MasterReport {
  return {
    index,
    requestId,
    reservationId: null,
    edlId,
    compositionId: null,
    idempotencyKey: null,
    renderId: null,
    videoId: null,
    uri: null,
    artifactIds: { productionRequest: null, budgetReservation: null, edl: null, composition: null, gateResult: null, renderedVideo: null },
    cost: { estimateUsd: null, reservedUsd: null, renderEstimateUsd: null, actualUsd: null, actualIsEstimate: null, releasedUsd: null, finalReservedUsd: null },
    ledger: [],
    probe: null,
    integrity: null,
    checks: {},
    failure: null,
    pass: false,
  };
}

/** The HyperFrames adapter, with the signed video URL remembered so the integrity probe can use it when the file is large. */
function withVideoUrlCapture(adapter: RenderAdapter): { adapter: RenderAdapter; videoUrl: () => string | null } {
  let captured: string | null = null;
  return {
    adapter: {
      renderer: adapter.renderer,
      ready: () => adapter.ready(),
      submit: (input) => adapter.submit(input),
      poll: (renderId) => adapter.poll(renderId),
      async fetchResult(status) {
        captured = status.videoUrl ?? null;
        return adapter.fetchResult(status);
      },
    },
    videoUrl: () => captured,
  };
}

type CheckContext = {
  edl: EditDecisionList;
  outcome: RenderOutcome | null;
  tolerance: number;
  /** True only when releaseReservation returned the reservation in state "released". */
  reservationReleased: boolean;
};

function checksFor(master: MasterReport, context: CheckContext): Record<string, boolean> {
  const { edl, outcome, tolerance } = context;
  const probe = master.probe;
  const entries = master.ledger;
  const video = outcome?.video ?? null;
  const fpsOk = probe?.fps !== null && probe?.fps !== undefined && probe.fps.num === edl.fps * probe.fps.den && Math.abs(probe.fps.value - edl.fps) < 0.01;
  const durationOk = probe?.durationMs !== null && probe?.durationMs !== undefined && Math.abs(probe.durationMs - edl.durationMs) <= tolerance;
  const sole = entries.length === 1 ? entries[0] : null;
  return {
    rendered: outcome !== null,
    resolution_1080x1920: probe?.width === edl.width && probe?.height === edl.height,
    fps_30: fpsOk === true,
    duration_within_tolerance: durationOk === true,
    audio_present_aac: probe?.audioPresent === true && probe.audioCodec === "aac",
    integrity_gate_pass: master.integrity?.pass === true,
    ledger_one_render_entry: sole !== null && sole.stage === "render",
    ledger_actual_is_render_cost: sole !== null && video !== null && sole.actualUsd === video.costUsd,
    ledger_key_is_composition_hash: sole !== null && master.idempotencyKey !== null && sole.idempotencyKey === master.idempotencyKey,
    reservation_released: context.reservationReleased,
    artifacts_written: Object.values(master.artifactIds).every((id) => id !== null),
  };
}

async function runMaster(index: number, options: RunOptions, ports: RunPorts, mediaFunctions: HttpMediaFunctions): Promise<MasterReport> {
  const { gateway, backend } = ports;
  const org = options.organizationId;
  const requestId = newId("req_");
  const edlId = newId("edl_");
  const master = emptyMaster(index, requestId, edlId);
  const tolerance = integrityLimitsFromConfig().durationToleranceMs;
  const edl = buildE1Edl({ edlId, requestId, stockUri: options.stockUri, voiceUri: options.voiceUri });
  let outcome: RenderOutcome | null = null;
  let composition: Composition | null = null;
  let reservation: BudgetReservation | null = null;
  const capture: { gate: GateResult | null; probe: ProbeResult | null } = { gate: null, probe: null };

  try {
    const createdAt = nowIso();
    const requestArtifact = await backend.beginRequest({
      organizationId: org,
      requestId,
      brandId: options.brandId,
      body: buildE1Request({ requestId, workspaceId: org, budgetUsd: options.requestBudgetUsd }),
      createdAt,
    });
    master.artifactIds.productionRequest = requestArtifact.artifactId;

    const reserved = await reserve(backend.ledger, {
      requestId,
      workspaceId: org,
      mode: "cap",
      plan: buildE1Plan({ requestId }),
      requestBudgetUsd: options.requestBudgetUsd,
      workspaceMonthBudgetUsd: options.workspaceMonthBudgetUsd,
      now: createdAt,
    });
    reservation = reserved.reservation;
    master.reservationId = reservation.reservationId;
    master.cost.estimateUsd = reservation.estimateUsd;
    master.cost.reservedUsd = reservation.reservedUsd;
    if (reservation.state !== "reserved") {
      throw new EngineError("conflict", `the reservation is ${reservation.state}: ${reservation.pausedReason ?? "no reason given"}; no call was made`);
    }
    const renderLine = reservation.lines.find((line) => line.stage === budgets.fixedStages.render);
    if (!renderLine) throw new EngineError("internal", "the reservation has no render line");
    master.cost.renderEstimateUsd = renderLine.estimateUsd;

    const reservationArtifact = await backend.writeArtifact({
      organizationId: org,
      requestId,
      stage: "estimate_reserve",
      type: "budget_reservation",
      body: reservation,
      parentIds: [requestArtifact.artifactId],
      createdAt: nowIso(),
    });
    master.artifactIds.budgetReservation = reservationArtifact.artifactId;

    const edlArtifact = await backend.writeArtifact({
      organizationId: org,
      requestId,
      stage: "edit",
      type: "edl",
      body: edl,
      parentIds: [requestArtifact.artifactId, reservationArtifact.artifactId],
      createdAt: nowIso(),
    });
    master.artifactIds.edl = edlArtifact.artifactId;

    const compiled = compile(edl, e1StyleKit());
    composition = compiled.composition;
    master.compositionId = composition.compositionId;
    master.idempotencyKey = composition.contentHash;
    const compositionArtifact = await backend.writeArtifact({
      organizationId: org,
      requestId,
      stage: "compose",
      type: "composition",
      body: composition,
      parentIds: [edlArtifact.artifactId],
      createdAt: nowIso(),
    });
    master.artifactIds.composition = compositionArtifact.artifactId;

    const { adapter, videoUrl } = withVideoUrlCapture(
      new HyperframesCloudAdapter({
        transport: gateway.transportFor("heygen", org),
        credential: gateway.secretFor("heygen", org),
      }),
    );

    const verifyIntegrity = async (input: IntegrityInput): Promise<GateResult> => {
      // The bytes are probed when they fit inline; a larger file is probed at its signed URL, which is the same file.
      let source: MediaSource;
      if (input.bytes.byteLength <= FFMPEG_LIMITS.maxInlineBytes) {
        source = { kind: "bytes", bytes: new Uint8Array(input.bytes) };
      } else {
        const url = videoUrl();
        if (url === null) {
          throw new EngineError("invalid_input", "the rendered video is above the inline limit and has no URL to probe", { stage: "render_integrity" });
        }
        source = { kind: "url", url };
      }
      const probe = await mediaFunctions.probe({ source });
      capture.probe = probe;
      const result = checkRenderIntegrity(
        { videoId: input.videoId, probe, edl },
        { durationToleranceMs: tolerance, platformMaxBytes: options.platformMaxBytes },
      );
      capture.gate = result;
      return result;
    };

    outcome = await renderComposition(
      {
        requestId,
        reservationId: reservation.reservationId,
        composition,
        files: compiled.files,
        assets: compiled.assets,
        durationMs: edl.durationMs,
        estimateUsd: renderLine.estimateUsd,
        now: nowIso(),
        title: TITLE,
      },
      {
        adapter,
        ledger: backend.ledger,
        resolveAsset: async (uri) => {
          const bytes = await backend.media.read(uri);
          if (bytes === null) throw new EngineError("not_found", `the asset ${uri} is not in the store`, { stage: "render" });
          return bytes;
        },
        verifyIntegrity,
        storeVideo: async ({ videoId, bytes }) =>
          backend.media.write({
            key: mediaKey({ workspaceId: org, requestId, stage: "render", artifactId: videoId, extension: "mp4" }),
            mimeType: "video/mp4",
            bytes,
          }),
        pollIntervalMs: options.pollIntervalMs,
        sleep: options.sleep,
      },
    );
    master.renderId = outcome.renderId;
    master.videoId = outcome.video.videoId;
    master.uri = outcome.video.uri;
    const passedGate = capture.gate;
    if (passedGate === null) throw new EngineError("internal", "a rendered video has no integrity result", { stage: "render_integrity" });

    const gateArtifact = await backend.writeArtifact({
      organizationId: org,
      requestId,
      stage: "render_integrity",
      type: "gate_result",
      body: passedGate,
      parentIds: [compositionArtifact.artifactId],
      createdAt: nowIso(),
    });
    master.artifactIds.gateResult = gateArtifact.artifactId;
    const videoArtifact: ArtifactEnvelope<unknown> = await backend.writeArtifact({
      organizationId: org,
      requestId,
      stage: "render",
      type: "rendered_video",
      body: outcome.video satisfies RenderedVideo,
      parentIds: [compositionArtifact.artifactId, gateArtifact.artifactId],
      createdAt: nowIso(),
    });
    master.artifactIds.renderedVideo = videoArtifact.artifactId;
  } catch (error) {
    master.failure = describeError(error);
  }

  // Whatever happened, the unspent part of the hold goes back, and the ledger is read back as the record of the run.
  let reservationReleased = false;
  if (capture.probe !== null) master.probe = capture.probe;
  if (capture.gate !== null) master.integrity = { pass: capture.gate.pass, checks: capture.gate.checks };
  if (reservation !== null) {
    const released = await releaseReservation(backend.ledger, reservation.reservationId);
    reservationReleased = released.reservation.state === "released";
    const entries = await backend.ledger.listEntries(reservation.reservationId);
    master.ledger = entries.map((entry) => ({
      entryId: entry.entryId,
      stage: entry.stage,
      provider: entry.provider,
      model: entry.model,
      estimateUsd: entry.estimateUsd,
      reservedUsd: entry.reservedUsd,
      actualUsd: entry.actualUsd ?? null,
      actualIsEstimate: entry.actualIsEstimate ?? null,
      idempotencyKey: entry.idempotencyKey,
    }));
    master.cost.actualUsd = sumOrNull(entries.map((entry) => entry.actualUsd));
    master.cost.actualIsEstimate = entries.length === 0 ? null : entries.some((entry) => entry.actualIsEstimate === true);
    master.cost.releasedUsd = released.releasedUsd;
    master.cost.finalReservedUsd = released.reservation.reservedUsd;
  }

  master.checks = checksFor(master, { edl, outcome, tolerance, reservationReleased });
  master.pass = master.failure === null && Object.values(master.checks).every(Boolean);
  return master;
}

/** Runs the E1 acceptance: `count` masters, one after another. The report says what happened; a failure is a result, not a throw. */
export async function runE1(options: RunOptions, ports: RunPorts): Promise<E1Report> {
  const startedAt = nowIso();
  const org = options.organizationId;
  for (const uri of [options.stockUri, options.voiceUri]) {
    const bytes = await ports.backend.media.read(uri);
    if (bytes === null) {
      throw new EngineError("not_found", `the asset ${uri} is not in the store; nothing was spent`, { stage: "e1" });
    }
  }
  const mediaFunctions = httpMediaFunctions(
    ports.gateway.baseUrlFor("media_functions"),
    textTransport(ports.gateway.transportFor("media_functions", org)),
  );

  const masters: MasterReport[] = [];
  for (let index = 1; index <= options.count; index += 1) {
    masters.push(await runMaster(index, options, ports, mediaFunctions));
  }

  const reservedTotals = masters.map((master) => master.cost.reservedUsd);
  const releasedTotals = masters.map((master) => master.cost.releasedUsd ?? 0);
  const passed = masters.filter((master) => master.pass).length;
  return {
    schema: E1_REPORT_SCHEMA,
    mode: options.mode,
    backend: ports.backend.label,
    provenance: options.provenance,
    organizationId: org,
    brandId: options.brandId,
    count: options.count,
    budgets: { requestUsd: options.requestBudgetUsd, workspaceMonthUsd: options.workspaceMonthBudgetUsd },
    platformMaxBytes: { value: options.platformMaxBytes, source: options.platformMaxBytesSource },
    startedAt,
    finishedAt: nowIso(),
    masters,
    totals: {
      masters: masters.length,
      passed,
      estimateUsd: sumOrNull(masters.map((master) => master.cost.estimateUsd)) ?? 0,
      reservedUsd: sumOrNull(reservedTotals) ?? 0,
      renderEstimateUsd: sumOrNull(masters.map((master) => master.cost.renderEstimateUsd)) ?? 0,
      actualUsd: sumOrNull(masters.map((master) => master.cost.actualUsd)),
      releasedUsd: sumOrNull(releasedTotals) ?? 0,
    },
    billVerified: false,
    notes: [
      "The actual cost is the render line's list estimate. The HyperFrames adapter reads no bill from HeyGen (render/STATUS.md), so ledger actuals are flagged actualIsEstimate.",
      "Claude, speech-to-text and generation lines of each reservation are released unspent: E1 makes no such call.",
      "Stock and component shots price at $0 (config/prices.ts), so the estimate is the fixed per-master lines.",
    ],
    pass: masters.length > 0 && passed === masters.length,
  };
}
