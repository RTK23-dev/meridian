// The `check_take` stage (Video Engine Bible 6.7, 12.2, 5.3). It checks one take and returns its verdict.
//
// What it reads: the take artifact and the scene plan (for the shot the take was made for). What it does: reads the stored file,
// takes the rubric frames (6, evenly spaced, Bible 6.7), takes the code measurements, and runs runTakeCheck (review/takeCheck.ts):
// the code checks, the similarity checks, and the Critic through the Claude client on the request's reservation. Then it writes the
// verdict as a take_verdict artifact and returns the gate and the verdict for the orchestrator to route.
//
// Missing evidence stays missing (Bible 12). The defaults are not connected, so they fail closed and send the take to review:
//   - similarity scorer: notConnectedScorer (no embedding vendor is chosen, Bible 20.2)
//   - palette: no style kit is loaded here, so the palette list is empty
//   - product and persona: the shot's kit is not loaded, so the hero and portrait lists are empty (not evaluated)
//   - measurements: black or frozen frames, flicker and motion come from the media detectors when they are wired (`detectors`);
//     a detector that refuses the take's file leaves its measure missing
//   - gold metrics: none, so no check can block on a learned threshold (Bible 12.4)
// A stored take that is missing from storage is an internal error, never a verdict on nothing.
//
// The review item (Bible 12.5) is built where the escalation is decided (orchestrator.ts), from the verdicts this stage returns.

import { EngineError, newId, scenePlanSchema, takeSchema, type ShotSpec, type Take } from "../../contracts/index.ts";
import type { Gateway } from "../../gateway/gateway.ts";
import type { RoleCallJournal, RoleDeps } from "../../claude/client.ts";
import { thresholds } from "../../config/thresholds.ts";
import { runTakeCheck, type TakeCheckRun } from "../../review/takeCheck.ts";
import { notConnectedScorer, type SimilarityScorer } from "../../review/take/similarity.ts";
import type { TakeMeasurements } from "../../review/take/code.ts";
import type { TakeGoldMetrics, TakeShot } from "../../review/take/types.ts";
import type { MediaFunctions } from "../../media/interface.ts";
import { takeMeasurementsFromDetectors, type TakeDetectors } from "../gate-measures.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { readJobInputs, writeArtifact, type MediaStorePort, type StoredArtifact } from "../artifact-store.ts";
import { scopedLedgerStore } from "../asset-stores-sql.ts";
import { sqlRoleCallJournal } from "../role-call-store.ts";
import type { StageContext, StageHandler, StageOutput, StageRunResult } from "../types.ts";

/** The shot kinds whose kit the shot needs for a similarity check (Bible 6.7 step 2). */
const PRODUCT_VISUAL_TYPES = new Set(["product_hero"]);
const PERSONA_VISUAL_TYPES = new Set(["ugc_presenter"]);

/**
 * A take that the plan made with a model, from a chain of calls (contract v5), or from stock must move, so the motion check applies
 * (Bible 6.7). A chain's take is its last call's video, so it is generated like any other take.
 */
function motionRequiredFor(shot: ShotSpec): boolean {
  return shot.source.kind === "generate" || shot.source.kind === "stock" || shot.source.kind === "chain";
}

/** The shot facts the take check needs, from the plan. Kits are not loaded here, so their lists are empty (not evaluated). */
export function takeShotOf(shot: ShotSpec): TakeShot {
  return {
    shotId: shot.shotId,
    visualType: shot.visualType,
    plannedDurationMs: shot.endMs - shot.startMs,
    motionRequired: motionRequiredFor(shot),
    product: PRODUCT_VISUAL_TYPES.has(shot.visualType) ? { heroUris: [] } : null,
    persona: PERSONA_VISUAL_TYPES.has(shot.visualType) ? { portraitUris: [] } : null,
  };
}

/** Evenly spaced frame times across the take, strictly ascending and inside it (Bible 6.7: six frames). */
export function frameTimesFor(durationMs: number, count: number = thresholds.take.rubricFrames): number[] {
  if (!Number.isInteger(durationMs) || durationMs <= 0 || !Number.isInteger(count) || count < 1) return [];
  const times = Array.from({ length: count }, (_, index) => Math.floor(((index + 0.5) * durationMs) / count));
  return times.every((time, index) => time < durationMs && (index === 0 || time > (times[index - 1] ?? -1))) ? times : [];
}

/** The measurements the probe gave us. The rest are unknown, so their checks are missing evidence (Bible 12). */
export function probedMeasurements(take: Take): TakeMeasurements {
  return { durationMs: take.durationMs, blackOrFrozenRunFrames: null, flickerScore: null, meanMotion: null };
}

export type TakeMeasurer = (input: { take: Take; bytes: Uint8Array }) => Promise<TakeMeasurements>;

export type CheckTakePorts = {
  gateway: Gateway;
  /** Frames of the stored take (media functions). */
  media: Pick<MediaFunctions, "frames">;
  /** The object store the take's media is read from. */
  objects: MediaStorePort;
  scorer?: SimilarityScorer;
  /**
   * The media detectors (Bible 6.7 step 1): black or frozen frames, flicker and motion, measured on the take's bytes. Absent, those
   * checks are missing evidence. `measure`, when given, takes precedence (a test or a deployment with its own measurement).
   */
  detectors?: TakeDetectors;
  measure?: TakeMeasurer;
  /** The style kit's palette, as hex colours. Absent, the palette check is missing evidence. */
  paletteHex?: (input: { organizationId: string; requestId: string }) => Promise<string[]>;
  /** Learned gold metrics by key. Absent, no check can block (Bible 12.4). */
  metrics?: () => Promise<TakeGoldMetrics>;
  /** The clock as an ISO time, for the ledger and the artifacts. */
  now?: () => string;
};

type TakeInputs = { takeArtifact: StoredArtifact; take: Take; shot: ShotSpec };

async function takeInputsOf(ctx: StageContext): Promise<TakeInputs> {
  const inputs = await readJobInputs(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const takeArtifact = inputs.find((input) => input.envelope.type === "take");
  const planArtifact = inputs.find((input) => input.envelope.type === "scene_plan");
  if (!takeArtifact || !planArtifact) {
    throw new EngineError("invalid_input", "check_take needs its take and scene_plan input artifacts", { stage: ctx.stage });
  }
  const plan = scenePlanSchema.safeParse(planArtifact.envelope.body);
  if (!plan.success) throw new EngineError("invalid_input", "the scene plan does not parse", { stage: ctx.stage });
  const take = takeSchema.safeParse(takeArtifact.envelope.body);
  if (!take.success) throw new EngineError("invalid_input", "the take does not parse", { stage: ctx.stage });
  const shot = plan.data.shots.find((candidate) => candidate.shotId === take.data.shotId);
  if (!shot) throw new EngineError("invalid_input", `the scene plan has no shot ${take.data.shotId}`, { stage: ctx.stage });
  if (take.data.takeId !== ctx.subjectId) throw new EngineError("invalid_input", `the take input is ${take.data.takeId}, not ${ctx.subjectId}`, { stage: ctx.stage });
  return { takeArtifact, take: take.data, shot };
}

async function brandOf(sql: Sql, organizationId: string, requestId: string): Promise<string> {
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const brand = rows[0]?.brand_id ?? null;
  if (brand === null) throw new EngineError("invalid_input", "the request has no brand, so its take media cannot be read (Bible 5.2)", { stage: "check_take" });
  return brand;
}

/** Six frames of the stored take as PNG data URLs. A frame call the media functions refuse is missing evidence, not a guess. */
async function framesOf(ctx: StageContext, ports: CheckTakePorts, take: Take, bytes: Uint8Array<ArrayBuffer>): Promise<Array<{ atMs: number; imageUrl: string }> | null> {
  const atMs = frameTimesFor(take.durationMs);
  if (atMs.length === 0) return null;
  try {
    const result = await ports.media.frames({ source: { kind: "bytes", bytes }, atMs });
    if (result.frames.length !== atMs.length) return null;
    return [...result.frames]
      .sort((a, b) => a.atMs - b.atMs)
      .map((frame) => ({ atMs: frame.atMs, imageUrl: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}` }));
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return null;
    throw error;
  }
}

/** The take's bytes. A take with no stored file is an integrity failure: the stage fails, it does not judge nothing. */
async function bytesOf(ctx: StageContext, ports: CheckTakePorts, take: Take): Promise<Uint8Array<ArrayBuffer>> {
  const brandId = await brandOf(ctx.sql, ctx.organizationId, ctx.requestId);
  const object = await ports.objects.get(ctx.organizationId, brandId, take.uri);
  if (!object) throw new EngineError("not_found", `the media of take ${take.takeId} is missing from the object store`, { stage: ctx.stage });
  return new Uint8Array(object.bytes);
}

function reservationOf(ctx: StageContext): string {
  if (ctx.payload.budgetReservationId === null) {
    throw new EngineError("invalid_input", "check_take is a paid stage and has no budget reservation (Bible 14)", { stage: ctx.stage });
  }
  return ctx.payload.budgetReservationId;
}

function attemptOf(ctx: StageContext): number {
  const attempt = Number(ctx.payload.attempt);
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
}

/** Runs the check for one take and stores its verdict (Bible 6.7 step 4). */
export async function checkOneTake(ctx: StageContext, ports: CheckTakePorts): Promise<{ run: TakeCheckRun; verdictArtifactId: string; shotId: string }> {
  const { takeArtifact, take, shot } = await takeInputsOf(ctx);
  const bytes = await bytesOf(ctx, ports, take);
  const frames = await framesOf(ctx, ports, take, bytes);
  const measurements = ports.measure
    ? await ports.measure({ take, bytes })
    : ports.detectors
      ? await takeMeasurementsFromDetectors(ports.detectors, { take, bytes })
      : probedMeasurements(take);
  const palette = ports.paletteHex ? await ports.paletteHex({ organizationId: ctx.organizationId, requestId: ctx.requestId }) : [];
  const metrics = ports.metrics ? await ports.metrics() : {};
  const role: RoleDeps = {
    gateway: ports.gateway,
    ledger: scopedLedgerStore(ctx.sql, ctx.organizationId, reservationOf(ctx)),
    now: ports.now ?? (() => new Date().toISOString()),
    journal: sqlRoleCallJournal(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId }) as RoleCallJournal,
  };
  const run = await runTakeCheck(
    { role, scorer: ports.scorer ?? notConnectedScorer() },
    {
      requestId: ctx.requestId,
      workspaceId: ctx.organizationId,
      reservationId: reservationOf(ctx),
      attempt: attemptOf(ctx),
      signal: ctx.signal,
      takeId: take.takeId,
      takeDurationMs: take.durationMs,
      shot: takeShotOf(shot),
      measurements,
      frames,
      paletteHex: palette,
      metrics,
    },
  );
  const verdictArtifact = await writeArtifact(ctx.sql, {
    organizationId: ctx.organizationId,
    requestId: ctx.requestId,
    stage: ctx.stage,
    type: "take_verdict",
    body: run.verdict,
    parentIds: [takeArtifact.envelope.artifactId],
    createdAt: (ports.now ?? (() => new Date().toISOString()))(),
    artifactId: newId("art_"),
  });
  return { run, verdictArtifactId: verdictArtifact.artifactId, shotId: take.shotId };
}

/** The check_take stage handler. It returns the gate and the verdict; the orchestrator routes them. */
export function createCheckTakeHandler(ports: CheckTakePorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const { run, verdictArtifactId, shotId } = await checkOneTake(ctx, ports);
      const output: StageOutput = {
        stage: "check_take",
        subjectId: run.verdict.takeId,
        shotId,
        takeId: run.verdict.takeId,
        gate: run.gate,
        verdict: run.verdict,
        artifacts: { [`verdict:${run.verdict.takeId}`]: verdictArtifactId },
      };
      return { kind: "done", output };
    },
  };
}
