// The `deliver` stage handler (Video Engine Bible 6.14, 14.1 steps 4 and 5, 16.1). It runs once the master and every variant that
// is going to deliver have settled. It does five things, in this order:
//
// 1. Chooses the delivered videos: the master, and each variant whose newest render has a passing post-render review (deliver/videos.ts).
//    The master must deliver, or the request does not.
// 2. Checks the ledger: every paid call must be settled from its bill or a confirmed absence, or the request is not delivered (the open
//    calls are named). Then releases the reservation to what is committed (deliver/ledger.ts, budget/reconcile.ts). Both run under the
//    reservation's lock. No estimate is booked as a cost (contract v6).
// 3. Writes one manifest per delivered video (deliver/manifest.ts): the shots its EDL plays, its gates, its decisions, its cost (the
//    rows attributed to it, deliver/cost.ts), its role calls and prompt versions (the master only, deliver/calls.ts), its timings and
//    its disclosure flags. Each manifest is an artifact under a stable id, so a retried job writes nothing twice.
// 4. Emits the learning events (events/schema.ts): a cost.reconciled per ledger row, a gate.result per gate, a video.delivered per video,
//    a variant.delivered per variant, and one request.delivered.
// 5. Returns the master's manifest id as the job's answer, and every manifest artifact by its slot.
//
// Ports: the row-locked ledger, the Claude role-call journal, the gate results and decisions the orchestrator stored, the paid-partnership
// answer (the request has no source for it, so it is unknown until the owner sets one), the event store and the clock.
// The orchestrator passes every artifact slot to this stage (Object.keys(state.artifacts)); registry.ts declares no reads for it. The
// stage refuses without the request, the plan, the DNA and a reservation (its ledger is the one it settles).

import type { z } from "zod";
import {
  compositionSchema,
  CONTRACTS_VERSION,
  contentHash,
  EngineError,
  edlSchema,
  gateResultSchema,
  productionRequestSchema,
  renderedVideoSchema,
  reviewResultSchema,
  scenePlanSchema,
  takeSchema,
  videoDnaSchema,
  type Decision,
  type EditDecisionList,
  type GateResult,
  type ProductionRequest,
  type RenderedVideo,
  type ReviewResult,
  type ScenePlan,
  type Take,
  type VideoDNA,
} from "../../contracts/index.ts";
import type { JournalEntry } from "../../claude/journal.ts";
import { adapters } from "../../config/adapters.ts";
import { budgets } from "../../config/budgets.ts";
import { prices } from "../../config/prices.ts";
import { routes } from "../../config/routes.ts";
import { thresholds } from "../../config/thresholds.ts";
import { weights } from "../../config/weights.ts";
import type { LedgerStore } from "../../budget/store.ts";
import { emitLearningEvents } from "../../events/emit.ts";
import type { LearningEvent } from "../../events/schema.ts";
import type { EventStore } from "../../events/store.ts";
import { attributeRows, costOf, totalOf, type RenderLink } from "../../deliver/cost.ts";
import { requestCallsOf } from "../../deliver/calls.ts";
import { settleLedger } from "../../deliver/ledger.ts";
import { buildManifest, disclosuresFor, gatesFor, shotsFor, timingsFor, uniqueDecisions } from "../../deliver/manifest.ts";
import { selectVideos, type Stored, type VideoPick } from "../../deliver/videos.ts";
import { writeArtifactOnce } from "../../deliver/write-once.ts";
import { diffEdl } from "../../variants/diff.ts";
import { readJobInputs, type StoredArtifact } from "../artifact-store.ts";
import { writeManifestRow } from "../manifest-store.ts";
import { stableId } from "../stable-id.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

export type DeliverScope = { organizationId: string; requestId: string };

/** The ports of the deliver stage. Production wires them to the engine tables; tests pass fakes. */
export type DeliverPorts = {
  /** Runs fn with the request's ledger under the reservation's lock (sql-ledger-store withReservationLedger in production). */
  withLedger: <T>(scope: { organizationId: string; reservationId: string }, fn: (ledger: LedgerStore) => Promise<T>) => Promise<T>;
  /** The Claude role-call journal entries of the request (jobs/role-call-store listRoleCalls in production). */
  roleCalls: (scope: DeliverScope) => Promise<JournalEntry[]>;
  /** The gate results the orchestrator stored for the request (engine_gate_results in production). */
  gates: (scope: DeliverScope) => Promise<GateResult[]>;
  /** The decisions the orchestrator stored for the request (engine_decisions in production). */
  decisions: (scope: DeliverScope) => Promise<Decision[]>;
  /**
   * The owner's answer on paid partnership for this request. The request carries no such field, so no answer is a known unknown, and
   * the manifest discloses it (disclosuresFor). Undefined means unknown.
   */
  paidPartnership?: (scope: DeliverScope) => Promise<boolean | undefined>;
  events: EventStore;
  now: () => string;
};

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: "deliver" });
}

/** The one input of a type. Missing or repeated, it is refused. */
function one(stored: readonly StoredArtifact[], type: string): StoredArtifact {
  if (stored.length !== 1) throw refuse(`deliver needs exactly one ${type} input, and it has ${stored.length}`);
  const [only] = stored;
  if (only === undefined) throw refuse(`deliver needs its ${type} input`);
  return only;
}

function parseAs<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuse(`the ${what} artifact does not parse: ${issue ? issue.path.map(String).join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data as z.infer<S>;
}

/** The versions of the configuration the video was made with (Bible 16.3). The manifest contract has no field for them yet; the event carries them. */
export function configVersions(): Record<string, string> {
  return {
    contracts: CONTRACTS_VERSION,
    thresholds: thresholds.version,
    budgets: budgets.version,
    prices: prices.version,
    routes: routes.version,
    adapters: adapters.version,
    weights: weights.version,
  };
}

/** The band a variant's caption clips set where they differ from the master's, or null when none differs. */
function changedBand(master: EditDecisionList, variant: EditDecisionList): string | null {
  const before = new Map<string, unknown>();
  for (const track of master.tracks) {
    if (track.layer !== "captions") continue;
    for (const clip of track.clips) before.set(clip.clipId, clip.props?.band);
  }
  for (const track of variant.tracks) {
    if (track.layer !== "captions") continue;
    for (const clip of track.clips) {
      const band = clip.props?.band;
      if (typeof band === "string" && before.get(clip.clipId) !== band) return band;
    }
  }
  return null;
}

/** What a variant changes, when the EDL alone shows it: caption (and the band it set) or music. Null otherwise (unknown stays null). */
function variantChangeOf(master: EditDecisionList, variant: EditDecisionList): { attribute: string | null; value: string | null } {
  const surfaces = new Set(diffEdl(master, variant).map((change) => change.surface));
  if (surfaces.size === 1 && surfaces.has("captions")) return { attribute: "caption", value: changedBand(master, variant) };
  if (surfaces.size === 1 && surfaces.has("music")) return { attribute: "music", value: null };
  return { attribute: null, value: null };
}

/** The deliver stage. Pass the ports the worker wires (see DeliverPorts). */
export function createDeliverHandler(ports: DeliverPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const scope: DeliverScope = { organizationId: ctx.organizationId, requestId: ctx.requestId };
      const stored = await readJobInputs(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
      const ofType = (type: string): StoredArtifact[] => stored.filter((artifact) => artifact.envelope.type === type);

      const requestStored = one(ofType("production_request"), "production_request");
      const dnaStored = one(ofType("video_dna"), "video_dna");
      const planStored = one(ofType("scene_plan"), "scene_plan");
      const request: ProductionRequest = parseAs(productionRequestSchema, requestStored.envelope.body, "production_request");
      const dna: VideoDNA = parseAs(videoDnaSchema, dnaStored.envelope.body, "video_dna");
      const plan: ScenePlan = parseAs(scenePlanSchema, planStored.envelope.body, "scene_plan");
      if (plan.requestId !== ctx.requestId || dna.videoDnaId !== plan.videoDnaId) throw refuse("the plan or the DNA does not belong to this request");

      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) throw refuse("deliver needs the request's reservation, which it reconciles and releases; none is set");

      const edls: Stored<EditDecisionList>[] = ofType("edl").map((artifact) => ({
        body: parseAs(edlSchema, artifact.envelope.body, "edl"),
        createdAt: artifact.envelope.createdAt,
      }));
      const takes: Take[] = ofType("take").map((artifact) => parseAs(takeSchema, artifact.envelope.body, "take"));
      const renders: Stored<RenderedVideo>[] = ofType("rendered_video").map((artifact) => ({
        body: parseAs(renderedVideoSchema, artifact.envelope.body, "rendered_video"),
        createdAt: artifact.envelope.createdAt,
      }));
      const reviews: Stored<ReviewResult>[] = ofType("review_result").map((artifact) => ({
        body: parseAs(reviewResultSchema, artifact.envelope.body, "review_result"),
        createdAt: artifact.envelope.createdAt,
      }));
      const compositionIds = new Map<string, string>();
      for (const artifact of ofType("composition")) {
        const body = parseAs(compositionSchema, artifact.envelope.body, "composition");
        compositionIds.set(body.edlId, body.compositionId);
      }

      const selection = selectVideos({ edls, renders, reviews });
      const masterVideoId = selection.master.videoId;
      const videos: VideoPick[] = [selection.master, ...selection.variants];
      const masterEdl = selection.master.edl;

      // 2. Settle the ledger under the reservation's lock.
      const settled = await ports.withLedger({ organizationId: ctx.organizationId, reservationId }, (ledger) => settleLedger(ledger, reservationId));

      // The calls of the request: the role calls and prompt versions go on the master's manifest.
      const calls = requestCallsOf(await ports.roleCalls(scope));
      const unanswered = calls.unanswered;

      const gates: GateResult[] = (await ports.gates(scope)).map((gate) => parseAs(gateResultSchema, gate, `${gate.gate} gate`));
      const decisions = uniqueDecisions([...(await ports.decisions(scope)), ...plan.decisions]);
      const paid = ports.paidPartnership === undefined ? undefined : await ports.paidPartnership(scope);

      // 1 and 3. Attribute each row to a video, then write one manifest per delivered video.
      const renderLinks: RenderLink[] = renders.map((render) => ({ videoId: render.body.videoId, idempotencyKey: render.body.idempotencyKey }));
      const deliveredVariantVideoIds = new Set(selection.variants.map((variant) => variant.videoId));
      const byVideo = attributeRows(settled.rows, { masterVideoId, renders: renderLinks, deliveredVariantVideoIds });
      const videoOfRow = new Map<string, string>();
      for (const [videoId, rows] of byVideo) for (const row of rows) videoOfRow.set(row.entryId, videoId);

      const owned = new Map<string, Set<string>>();
      for (const video of videos) {
        const ids = new Set([video.edl.edlId, video.videoId]);
        const composition = compositionIds.get(video.edl.edlId);
        if (composition !== undefined) ids.add(composition);
        owned.set(video.videoId, ids);
      }
      const timingArtifacts = stored.map((artifact) => ({ type: artifact.envelope.type, createdAt: artifact.envelope.createdAt }));
      const requestCreatedAt = requestStored.envelope.createdAt;
      const at = ports.now();
      const artifacts: Record<string, string> = {};
      const costs = new Map<string, ReturnType<typeof costOf>>();
      const timings = new Map<string, Record<string, number>>();
      const events: LearningEvent[] = [];

      for (const video of videos) {
        const isMaster = video.videoId === masterVideoId;
        const others = new Set([...owned].filter(([id]) => id !== video.videoId).flatMap(([, ids]) => [...ids]));
        const videoGates = gatesFor(gates, owned.get(video.videoId) ?? new Set(), others);
        const cost = costOf(byVideo.get(video.videoId) ?? []);
        costs.set(video.videoId, cost);
        const videoTimings = timingsFor(timingArtifacts, requestCreatedAt, video.readyAt);
        timings.set(video.videoId, videoTimings);
        const shots = shotsFor(video.edl, plan, takes);
        const manifest = buildManifest({
          video: { videoId: video.videoId, edl: video.edl, variantOfVideoId: isMaster ? null : masterVideoId },
          request,
          dna,
          plan,
          takes,
          gates: videoGates,
          decisions,
          roleCalls: isMaster ? calls.roleCalls : [],
          promptVersions: isMaster ? calls.promptVersions : {},
          cost,
          disclosures: disclosuresFor(shots, plan, paid),
          timings: videoTimings,
        });
        const written = await writeArtifactOnce(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "manifest",
          body: manifest,
          parentIds: ctx.payload.inputArtifactIds,
          createdAt: at,
          artifactId: stableId("art_", `manifest|${ctx.requestId}|${video.videoId}`),
        });
        // The same manifest as a row of engine_manifests (Bible 5.4), under the artifact's id, so a retry writes it once.
        await writeManifestRow(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          artifactId: written.artifactId,
          variantOf: manifest.variantOf ?? null,
          body: manifest,
          createdAt: at,
        });
        artifacts[`manifest:${video.videoId}`] = written.artifactId;
      }

      // 4. The learning events. Each is keyed, so a retried job emits each once.
      for (const row of settled.rows) {
        events.push({
          kind: "cost.reconciled",
          stage: "deliver",
          subjectId: row.entryId,
          dedupeKey: `cost:${row.entryId}`,
          body: {
            entryId: row.entryId,
            requestId: ctx.requestId,
            stage: row.stage,
            provider: row.provider,
            model: row.model,
            role: row.role ?? null,
            estimateUsd: row.estimateUsd,
            reservedUsd: row.reservedUsd,
            actualUsd: row.actualUsd,
            settlement: row.settlement ?? null,
            videoId: videoOfRow.get(row.entryId) ?? masterVideoId,
          },
        });
      }
      for (const gate of gates) {
        events.push({
          kind: "gate.result",
          stage: gate.gate,
          subjectId: gate.subjectId,
          dedupeKey: `gate:${ctx.requestId}:${contentHash(gate)}`,
          body: gate,
        });
      }
      const versions = configVersions();
      for (const video of videos) {
        const isMaster = video.videoId === masterVideoId;
        const cost = costs.get(video.videoId);
        if (cost === undefined) throw new EngineError("internal", `no cost was read for ${video.videoId}`, { stage: "deliver" });
        events.push({
          kind: "video.delivered",
          stage: "deliver",
          subjectId: video.videoId,
          dedupeKey: `video:${video.videoId}`,
          body: {
            manifestId: video.videoId,
            requestId: ctx.requestId,
            edlId: video.edl.edlId,
            variantOf: isMaster ? null : masterVideoId,
            cost,
            timings: timings.get(video.videoId) ?? {},
            configVersions: versions,
          },
        });
        if (!isMaster) {
          const change = variantChangeOf(masterEdl, video.edl);
          events.push({
            kind: "variant.delivered",
            stage: "deliver",
            subjectId: video.videoId,
            dedupeKey: `variant:${video.videoId}`,
            body: { videoId: video.videoId, edlId: video.edl.edlId, variantOf: masterVideoId, attribute: change.attribute, value: change.value, cost },
          });
        }
      }
      events.push({
        kind: "request.delivered",
        stage: "deliver",
        subjectId: ctx.requestId,
        dedupeKey: `request:${ctx.requestId}`,
        body: {
          requestId: ctx.requestId,
          reservationId,
          masterVideoId,
          deliveredVariantVideoIds: selection.variants.map((variant) => variant.videoId),
          undeliveredVariantEdlIds: selection.undelivered.map((item) => item.edlId),
          costTotalUsd: totalOf(settled.rows),
          unansweredCalls: unanswered,
          releasedUsd: settled.release.releasedUsd,
        },
      });
      await emitLearningEvents(ports.events, scope, events, { at, jobId: ctx.jobId });

      return {
        kind: "done",
        output: { stage: "deliver", subjectId: ctx.subjectId, artifacts, manifestId: masterVideoId },
      };
    },
  };
}
