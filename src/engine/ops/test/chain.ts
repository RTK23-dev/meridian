// Test helpers for the operations tests (Video Engine Bible 15.3, 15.5, 19 E6). Not a test file. Nothing here calls a live API.
//
// The upstream stages (intake, voice, plan, estimate, produce, check and edit) are answered from the chain fixtures, as the E4 and E5
// scenarios answer them. The stages after the edit run through the real handlers: compose, pre_render_gate, render (HyperFrames is a
// recorded adapter), post_render_review (the Critic answers from a recorded response), variants and deliver. Their jobs are claimed and
// retried by Meridian's own worker code (claimAndRun in lib/meridian/jobs/sql-worker.ts), so attempts, backoff, dead letters and the
// status changes are the real ones. The one test choice is the clock: a retry is due at once (fastForwardRetries), so a test does not
// wait out the backoff of 2 seconds and more.
//
// Every request gets its own ids. The fixtures name one request with fixed ids (request, reservation, shots, takes, EDL, video), and
// engine_requests, engine_reservations and engine_manifests key those ids on their own, across workspaces. RequestIds replaces every
// prefixed ULID in a document with a fresh one for that request. The same original always gives the same fresh id within a request, so
// the references between documents still hold.

import { reviewerClipUris } from "../../jobs/reviewer-clips.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  budgetReservationSchema,
  encodeUlid,
  EngineError,
  type EditDecisionList,
  type GateResult,
  type ProductionRequest,
  type TakeVerdict,
} from "../../contracts/index.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { fixtureId } from "../../contracts/fixtures/index.ts";
import { cleanRender, drawnOverlays, integrityPassed } from "../../review/test/render.ts";
import type { TimelineResult } from "../../media/interface.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { claimAndRun } from "../../../lib/meridian/jobs/sql-worker.ts";
import { scopedLedgerStore } from "../../jobs/asset-stores-sql.ts";
import { writeArtifact } from "../../jobs/artifact-store.ts";
import { sqlEventStore } from "../../jobs/event-store-sql.ts";
import { executeEngineJob } from "../../jobs/dispatch.ts";
import { gateResultsOf, decisionsOf } from "../../jobs/engine-reads-sql.ts";
import { notConnectedWorkspaceBudget } from "../../jobs/handlers/estimate-reserve.ts";
import { applyEngineEvent, startEngineRequest } from "../../jobs/orchestrator-sql.ts";
import { listRoleCalls } from "../../jobs/role-call-store.ts";
import { createEngineRuntime } from "../../jobs/runtime.ts";
import { withRenderBills } from "../../jobs/test/harness.ts";
import { sqlLedgerStore, withReservationLedger } from "../../jobs/sql-ledger-store.ts";
import type { EngineRuntime, ShotSummary, StageOutput } from "../../jobs/types.ts";
import { fakeObjects, gatewayWith, json, PNG_1X1, recordedTransport } from "../../jobs/test/harness.ts";
import type { RenderAdapter, RenderSubmitInput } from "../../render/hyperframesCloud.ts";

/** The workspace clock of the fixtures. Only the artifact rows carry it; the engine's own events take the real clock. */
const CREATED = "2026-10-15T10:00:00.000Z";
const EPOCH_MS = Date.UTC(2026, 9, 13, 9, 0, 0);
const ID_IN_TEXT = /\b([a-z]+_)([0-9A-HJKMNP-TV-Z]{26})\b/g;
const CRITIC_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "review", "test", "fixtures", "openrouter-critic-final-ok.json");
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);

/** The music track a variant request names (the same track the E5 scenarios use). */
export const MUSIC = { trackId: "track_fixture_music", uri: "store://music/fixture-bed.mp3", durationMs: 60_000 };

/** The stages a worker runs on its own in this harness. Every other stage is answered by the test, from the chain fixtures. */
export const REAL_STAGES = ["compose", "pre_render_gate", "render", "post_render_review", "variants", "deliver"] as const;

// --- Per-request ids ----------------------------------------------------------------------------------------------------------

export type RequestIds = {
  /** The fresh id for an original id. The same original gives the same fresh id for this request. */
  id(original: string): string;
  /** A new id with the prefix, never given out before (a new video for each render). */
  fresh(prefix: string): string;
  /** A copy of a JSON-able value with every prefixed ULID replaced through id(). */
  value<T>(value: T): T;
};

/** The ids of request slot n (1 to 1000). Slots never share an id, so requests in one database stay apart. */
export function requestIds(slot: number): RequestIds {
  if (!Number.isInteger(slot) || slot < 1 || slot > 1000) throw new Error("a request slot is a whole number from 1 to 1000");
  const mapped = new Map<string, string>();
  let counter = slot * 1000;
  const fresh = (prefix: string): string => {
    counter += 1;
    return `${prefix}${encodeUlid(EPOCH_MS + counter * 1000, BigInt(counter) * 1000003n)}`;
  };
  const id = (original: string): string => {
    const known = mapped.get(original);
    if (known !== undefined) return known;
    const created = fresh(original.slice(0, original.indexOf("_") + 1));
    mapped.set(original, created);
    return created;
  };
  const value = <T>(input: T): T => JSON.parse(JSON.stringify(input).replace(ID_IN_TEXT, (whole) => id(whole))) as T;
  return { id, fresh, value };
}

// --- Fixture helpers ----------------------------------------------------------------------------------------------------

let cleanRenderCache: ReturnType<typeof cleanRender> | undefined;
/** The editor's EDL and its media for the E1 chain (built once; the build is deterministic). */
function cleanRenderOnce(): ReturnType<typeof cleanRender> {
  cleanRenderCache ??= cleanRender();
  return cleanRenderCache;
}

function mediaUrisOf(edl: EditDecisionList): Set<string> {
  const uris = new Set<string>();
  for (const track of edl.tracks) for (const clip of track.clips) if (clip.srcUri) uris.add(clip.srcUri);
  for (const clip of [edl.audio.voice, ...edl.audio.sfx, ...(edl.audio.music ? [edl.audio.music] : [])]) uris.add(clip.uri);
  return uris;
}

function cleanTimeline(): TimelineResult {
  const loudness = Array.from({ length: 600 }, (_, index) => ({ atMs: index * 100, lufs: -18 as number | null }));
  return { videoPresent: true, audioPresent: true, brightness: [], motion: [], loudness, envelope: { stepMs: 10, rms: [] } };
}

/** The chain's plan as the plan stage reports it (ShotSummary). */
function planShots(): ShotSummary[] {
  return fx.scenePlanFixture.shots.map(
    (shot): ShotSummary => ({
      shotId: shot.shotId,
      visualType: shot.visualType,
      downgradeTo: shot.downgradeTo ?? null,
      sourceKind: shot.source.kind === "generate" ? "generate" : shot.source.kind === "stock" ? "stock" : shot.source.kind === "component" ? "component" : "asset",
      modelClass: shot.source.kind === "generate" ? shot.source.modelClass : null,
      takesWanted: shot.source.kind === "generate" ? (shot.source.takes as 1 | 2) : 1,
    }),
  );
}

/** A gate result for the request, as the test answers it. */
export function gateResult(name: GateResult["gate"], requestId: string, pass: boolean, failing: { rule?: string; shotIds?: string[] } = {}): GateResult {
  return {
    gate: name,
    subjectId: requestId,
    pass,
    checks: pass ? [{ rule: `${name}.ok`, pass: true }] : [{ rule: failing.rule ?? `${name}.broken`, pass: false, detail: "check detail" }],
    ...(failing.shotIds ? { failingShotIds: failing.shotIds } : {}),
  };
}

/** The production request of a variant run: the master and one music variant. */
export function musicVariantRequest(): ProductionRequest {
  return { ...fx.productionRequestFixture, output: { master: true, variants: { music: [MUSIC.trackId], maxVariants: 2, budgetUsd: 1 } } };
}

// --- Queue ---------------------------------------------------------------------------------------------------------------

/** Answers the oldest queued job of one stage and subject with a stage output, as the worker would after running it. */
export async function answerStage(
  sql: Sql,
  input: { organizationId: string; requestId: string; stage: string; subjectId: string; output: StageOutput },
): Promise<void> {
  const prefix = `engine:${input.requestId}:${input.stage}:${input.subjectId}:`;
  const rows = await sql<{ id: string }>`
    select id from jobs
    where organization_id = ${input.organizationId} and job_type = ${`engine.${input.stage}`} and status = 'queued'
      and left(idempotency_key, ${prefix.length}::int) = ${prefix}
    order by created_at asc, idempotency_key asc
    limit 1
  `;
  const job = rows[0];
  if (!job) throw new Error(`no queued ${input.stage} job for ${input.subjectId} to answer`);
  await applyEngineEvent(sql, {
    organizationId: input.organizationId,
    requestId: input.requestId,
    event: { type: "succeeded", output: input.output },
    triggerJobId: job.id,
    dedupeKey: `answer:${job.id}`,
  });
  await sql`update jobs set status = 'succeeded', result = 'answered', updated_at = now() where id = ${job.id}`;
}

export type DrainReport = { passes: number; claimed: number; done: number; retried: number; dead: number };

/** A retry is due at once in the harness (the backoff is a wall-clock choice, not part of the claim rule). */
async function fastForwardRetries(sql: Sql, organizationId: string): Promise<void> {
  await sql`update jobs set run_after = now() where organization_id = ${organizationId} and status = 'retry' and job_type like 'engine.%'`;
}

/**
 * Runs the real stages of every request in the workspace until nothing is due. Each job is claimed and run by claimAndRun with the
 * dispatcher, so the worker's status changes, attempt counts and dead-letter recording are the production ones. A job is due when it
 * is queued or retrying, its run time has come, and its parent job has succeeded (the worker's own rule). A queue that does not settle
 * within maxPasses is an error, never a silent stop.
 */
export async function drain(sql: Sql, runtime: EngineRuntime, organizationId: string, options: { maxPasses?: number } = {}): Promise<DrainReport> {
  const maxPasses = options.maxPasses ?? 500;
  const types = JSON.stringify(REAL_STAGES.map((stage) => `engine.${stage}`));
  const report: DrainReport = { passes: 0, claimed: 0, done: 0, retried: 0, dead: 0 };
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    await fastForwardRetries(sql, organizationId);
    const due = await sql<{ id: string }>`
      select id from jobs
      where organization_id = ${organizationId}
        and job_type in (select value from json_array_elements_text(${types}::json))
        and status in ('queued', 'retry') and run_after <= now() and cancel_requested = false
        and (depends_on = '' or exists (select 1 from jobs parent where parent.id = jobs.depends_on and parent.status = 'succeeded'))
      order by priority asc, created_at asc, id asc
    `;
    if (due.length === 0) {
      report.passes = pass - 1;
      return report;
    }
    for (const row of due) {
      const outcome = await claimAndRun(sql, row.id, (current, job) => executeEngineJob(current, job, runtime));
      report.claimed += 1;
      if (outcome.startsWith("retry:")) report.retried += 1;
      else if (outcome.startsWith("dead:")) report.dead += 1;
      else if (outcome !== "skipped") report.done += 1;
    }
  }
  throw new Error(`the queue did not settle within ${maxPasses} passes`);
}

// --- The world and the requests ----------------------------------------------------------------------------------------

type RequestEntry = { ids: RequestIds; brandId: string };

export type ChainWorld = {
  sql: Sql;
  organizationId: string;
  runtime: EngineRuntime;
  /** A request in this set fails its deliver stage on every attempt (an injected fault, cleared by removing it). */
  deliverFaults: Set<string>;
  objects: ReturnType<typeof fakeObjects>;
  requests: Map<string, RequestEntry>;
};

function hyperframesAdapter(renderIds: { next: number }): RenderAdapter<RenderSubmitInput> {
  return {
    renderer: "hyperframes-cloud",
    async ready() {
      return undefined;
    },
    async submit() {
      renderIds.next += 1;
      return { renderId: `hfr_chain_${renderIds.next}`, status: "queued" };
    },
    async poll(renderId) {
      return { renderId, status: "completed", videoUrl: `https://video.example.test/${renderId}.mp4` };
    },
    async fetchResult() {
      return { bytes: MP4 };
    },
  };
}

/**
 * The workspace's chain world: one composition root for every request in the workspace. The recorded providers are the HyperFrames
 * adapter (a completed render), the Critic (a recorded final answer, repeated), and the in-memory object store. No gateway call is
 * expected from the runtime itself, so any unexpected provider call fails the test.
 */
export async function chainWorld(sql: Sql, organizationId: string): Promise<ChainWorld> {
  const criticAnswer = JSON.parse(readFileSync(CRITIC_FIXTURE, "utf8")) as unknown;
  const critic = recordedTransport({ "POST /api/v1/chat/completions": json(200, criticAnswer) });
  const objects = fakeObjects();
  const deliverFaults = new Set<string>();
  const requests = new Map<string, RequestEntry>();
  const renderIds = { next: 0 };
  const now = (): string => new Date().toISOString();
  const entryOf = (requestId: string): RequestEntry => {
    const entry = requests.get(requestId);
    if (!entry) throw new EngineError("not_found", `request ${requestId} was not started in this chain world`);
    return entry;
  };
  const render = cleanRenderOnce();
  const runtime = withRenderBills(sql, createEngineRuntime({
    sql,
    gateway: gatewayWith(recordedTransport({}).transport),
    workspaceBudget: notConnectedWorkspaceBudget,
    now,
    styleKit: async () => fx.styleKitFixture,
    preRender: {
      renderBudget: async () => ({ remainingUsd: 10, renderEstimateUsd: 0.05 }),
      // The music variant swaps in the fixture track, which is licensed like the master's music (the same track the E5 scenarios use).
      // A reviewer\'s own clip is licensed by the reviewer\'s attestation (D12): its take is read from the request.
      licensedUris: async (scope) => new Set([...mediaUrisOf(render.edl), MUSIC.uri, ...(await reviewerClipUris(sql, scope.organizationId, scope.requestId))]),
      productImageUris: async () => [fx.BLENDER_FRONT_URI],
      disclosures: async () => ({ aiGeneratedPeople: true }),
    },
    render: {
      loadStyleKit: async () => fx.styleKitFixture,
      renderEstimateUsd: async () => 0.05,
      hyperframes: (scope) => {
        const entry = entryOf(scope.requestId);
        return {
          adapter: hyperframesAdapter(renderIds),
          ledger: scopedLedgerStore(sql, scope.organizationId, scope.reservationId),
          verifyIntegrity: async (input) => integrityPassed(input.videoId) as GateResult,
          storeVideo: async ({ videoId, bytes }) => {
            const key = `renders/${videoId}.mp4`;
            await objects.put({ organizationId, brandId: entry.brandId, key, mimeType: "video/mp4", bytes });
            return key;
          },
          resolveAsset: async () => MP4,
          pollIntervalMs: 0,
          sleep: async () => undefined,
          newVideoId: () => entry.ids.fresh("vid_"),
        };
      },
      now,
    },
    postRender: {
      gateway: gatewayWith(critic.transport),
      media: {
        async frames(request) {
          return { frames: request.atMs.map((atMs) => ({ atMs, width: 1080, height: 1920, png: PNG_1X1 })) };
        },
        async loudness() {
          return { integratedLufs: -14, truePeakDbtp: -2, loudnessRangeLu: 6 };
        },
        async timeline() {
          return cleanTimeline();
        },
      },
      objects,
      measureBlackFrames: async (input) => input.times.map((atMs) => ({ atMs, black: false })),
      measureOverlays: async ({ edl }) => drawnOverlays(edl).map((item) => ({ clipId: item.clipId, present: true })),
      measureOcr: async () => ({ captionWordsChecked: 24, captionWordsMismatched: 0, onScreenText: ["Send BLEND to get the link"] }),
      forbiddenTerms: async () => ["miracle cure"],
      now,
    },
    variants: {
      loadMusicTrack: async ({ trackId }) => (trackId === MUSIC.trackId ? MUSIC : undefined),
      loadStyleKit: async () => fx.styleKitFixture,
      withLedger: (scope, fn) => withReservationLedger(sql, scope.organizationId, scope.reservationId, fn),
      events: sqlEventStore(sql),
      now,
    },
    deliver: {
      withLedger: (scope, fn) => withReservationLedger(sql, scope.organizationId, scope.reservationId, fn),
      roleCalls: (scope) => listRoleCalls(sql, scope),
      gates: async (scope) => {
        if (deliverFaults.has(scope.requestId)) {
          throw new EngineError("provider", "injected fault: the deliver stage cannot reach its store", { retryable: true, stage: "deliver" });
        }
        return gateResultsOf(sql, scope);
      },
      decisions: (scope) => decisionsOf(sql, scope),
      events: sqlEventStore(sql),
      now,
    },
  }));
  return { sql, organizationId, runtime, deliverFaults, objects, requests };
}

export type ChainRequestInput = {
  slot: number;
  brandId: string;
  formatId: string;
  priority: "rush" | "normal" | "batch";
  variantCount: number;
  request?: ProductionRequest;
};

export type ChainRequest = { requestId: string; reservationId: string; slot: number };

/**
 * Starts one request and answers its upstream stages, so that it is queued at compose. The answers are the E4 and E5 scenario's: the
 * intake, voice, plan and estimate, the produce and check of every planned take (shot 3 takes two, and its first take fails its check),
 * and the edit. The real stages run later, in drain().
 */
export async function startChainRequest(world: ChainWorld, input: ChainRequestInput): Promise<ChainRequest> {
  const { sql, organizationId } = world;
  const ids = requestIds(input.slot);
  const requestId = ids.id(fx.FIXTURE_IDS.request);
  const reservationId = ids.id(fx.FIXTURE_IDS.reservation);
  const requestArtifactId = ids.id(fixtureId("art_", 40));
  const dnaArtifactId = ids.id(fixtureId("art_", 42));
  world.requests.set(requestId, { ids, brandId: input.brandId });

  await startEngineRequest(sql, {
    organizationId,
    brandId: input.brandId,
    requestId,
    formatId: input.formatId,
    priority: input.priority,
    cachedDna: true,
    cachedDnaArtifactId: dnaArtifactId,
    variantCount: input.variantCount,
    requestArtifactId,
  });
  await writeArtifact(sql, {
    organizationId,
    requestId,
    stage: "intake",
    type: "production_request",
    body: ids.value(input.request ?? fx.productionRequestFixture),
    createdAt: CREATED,
    artifactId: requestArtifactId,
  });
  await writeArtifact(sql, { organizationId, requestId, stage: "analyze_reference", type: "video_dna", body: ids.value(fx.videoDnaFixture), createdAt: CREATED, artifactId: dnaArtifactId });
  await sqlLedgerStore(sql, organizationId).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId,
      requestId,
      workspaceId: organizationId,
      mode: "cap",
      lines: [{ stage: "claude_roles", estimateUsd: 2 }],
      estimateUsd: 2,
      redoAllowanceUsd: 0,
      reservedUsd: 2,
      state: "reserved",
      createdAt: CREATED,
    }),
  );

  const store = async (stage: string, type: "validated_request" | "voice_track" | "scene_plan" | "take" | "take_verdict" | "edl", body: unknown): Promise<string> =>
    (await writeArtifact(sql, { organizationId, requestId, stage, type, body: body as never, createdAt: CREATED })).artifactId;
  const answer = (stage: string, subjectId: string, output: StageOutput): Promise<void> => answerStage(sql, { organizationId, requestId, stage, subjectId, output });

  const validatedId = await store("intake", "validated_request", ids.value(fx.validatedRequestFixture));
  await answer("intake", requestId, { stage: "intake", subjectId: requestId, gate: gateResult("request", requestId, true), budgetReservationId: reservationId, budgetPause: null, artifacts: { validated: validatedId } });
  const voiceId = await store("voice", "voice_track", ids.value(fx.voiceTrackFixture));
  await answer("voice", requestId, { stage: "voice", subjectId: requestId, gate: gateResult("voice", requestId, true), artifacts: { voice: voiceId } });
  const planId = await store("plan", "scene_plan", ids.value(fx.scenePlanFixture));
  await answer("plan", requestId, { stage: "plan", subjectId: requestId, gate: gateResult("plan", requestId, true), shots: ids.value(planShots()), artifacts: { plan: planId } });
  await answer("estimate_reserve", requestId, { stage: "estimate_reserve", subjectId: requestId, gate: gateResult("budget", requestId, true), budgetReservationId: reservationId, artifacts: {} });

  const produceAndCheck = async (shotId: string, takeId: string, take: unknown, pass: boolean): Promise<void> => {
    const takeArtifact = await store("produce_shot", "take", ids.value(take));
    await answer("produce_shot", shotId, { stage: "produce_shot", subjectId: shotId, shotId, epoch: 0, takeId, artifacts: { [`take:${takeId}`]: takeArtifact } });
    await answerCheck(shotId, takeId, pass);
  };
  const answerCheck = async (shotId: string, takeId: string, pass: boolean): Promise<void> => {
    const verdict: TakeVerdict = { takeId, pass, confidence: 0.9, checks: [{ rule: pass ? "slop.clean" : "slop.hands", pass }], action: pass ? "accept" : "redo" };
    const verdictId = await store("check_take", "take_verdict", ids.value(verdict));
    await answer("check_take", takeId, {
      stage: "check_take",
      subjectId: takeId,
      shotId,
      takeId,
      gate: gateResult("take", requestId, pass, { rule: "slop.hands" }),
      verdict: ids.value(verdict),
      artifacts: { [`verdict:${takeId}`]: verdictId },
    });
  };

  const shot1 = ids.id(fx.FIXTURE_IDS.shot1);
  const shot2 = ids.id(fx.FIXTURE_IDS.shot2);
  const shot3 = ids.id(fx.FIXTURE_IDS.shot3);
  const take1 = ids.id(fx.FIXTURE_IDS.take1);
  const take2 = ids.id(fx.FIXTURE_IDS.take2);
  const take3a = ids.id(fx.FIXTURE_IDS.take3a);
  const take3b = ids.id(fx.FIXTURE_IDS.take3b);
  await produceAndCheck(shot1, take1, fx.take1Fixture, true);
  const take3aArtifact = await store("produce_shot", "take", ids.value(fx.take3aFixture));
  await answer("produce_shot", shot3, { stage: "produce_shot", subjectId: shot3, shotId: shot3, epoch: 0, takeId: take3a, artifacts: { [`take:${take3a}`]: take3aArtifact } });
  // The failed check of take 3a queues the redo of shot 3, which produces take 3b. The check comes first: the redo is not queued before it.
  await answerCheck(shot3, take3a, false);
  await produceAndCheck(shot3, take3b, fx.take3bFixture, true);
  await produceAndCheck(shot2, take2, fx.take2Fixture, true);

  const render = cleanRenderOnce();
  const edlId = ids.id(render.edl.edlId);
  const edlArtifact = await store("edit", "edl", ids.value(render.edl));
  await answer("edit", requestId, { stage: "edit", subjectId: requestId, gate: gateResult("edit", requestId, true), edlId, artifacts: { [`edl:${edlId}`]: edlArtifact } });

  return { requestId, reservationId, slot: input.slot };
}

/** Marks a request's deliver stage as failing (true) or as working again (false). A request is never removed from the fault set by the harness. */
export function setDeliverFault(world: ChainWorld, requestId: string, failing: boolean): void {
  if (failing) world.deliverFaults.add(requestId);
  else world.deliverFaults.delete(requestId);
}
