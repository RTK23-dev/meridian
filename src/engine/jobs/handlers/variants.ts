// The `variants` stage handler (Video Engine Bible 6.13, 14.3). It runs once the master has passed post-render review. It reads the
// production request (the variant matrix), the scene plan (which shots are product, presenter and hook shots) and the master EDL, and
// expands the matrix into planned variants (variants/expand.ts). Then it builds what can be built without generation:
//
// - caption and music variants are EDL diffs of the master. Each is built, checked against its control (variants/diff.ts) and written
//   as an edl artifact that names the master as variantOf. The orchestrator then runs compose, pre-render, render and review for each.
// - hook, product, persona and language variants need produce_shot, the voice stage or the variant writer. This stage runs none of them
//   (a job has a two-minute lease; a take is minutes). Each is reported as deferred, with the work it needs, and nothing is charged.
//
// Every planned, deferred, skipped and unbuilt variant is written to the learning stream (variant.planned), so the request's variant
// plan is on record whether or not a variant was built. A variant that cannot be built fails alone; the stage does not fail for it.
//
// Inputs (the job reads only these, Bible 5.1): the production_request, the scene_plan, and the master edl (payload.details.masterEdlId).
// The orchestrator passes the request and the plan with the master (slots "request", "plan" and "edl:<master>", E4 pass): the stage
// refuses without them.
// The reservation (payload.budgetReservationId) is read for its headroom only. No ledger entry is written here.

import {
  EngineError,
  edlSchema,
  productionRequestSchema,
  scenePlanSchema,
  type EditDecisionList,
  type ProductionRequest,
  type ScenePlan,
} from "../../contracts/index.ts";
import { committedFor } from "../../budget/reserve.ts";
import type { LedgerStore } from "../../budget/store.ts";
import { roundUsd } from "../../contracts/money.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { emitLearningEvents } from "../../events/emit.ts";
import type { LearningEvent } from "../../events/schema.ts";
import type { EventStore } from "../../events/store.ts";
import { expandVariants, type PlannedVariant, type SkippedVariant, type VariantMusicTrack } from "../../variants/expand.ts";
import { buildRerenderVariant } from "../../variants/diff.ts";
import { variantMusicMix } from "../../variants/config.ts";
import { readJobInputs, type StoredArtifact } from "../artifact-store.ts";
import { stableId } from "../stable-id.ts";
import { writeArtifactOnce } from "../../deliver/write-once.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/** The ports of the variants stage. Production wires them to the music store, the row-locked ledger and the event table. */
export type VariantPorts = {
  /** The music track a matrix id names, or undefined when the workspace has no such track. */
  loadMusicTrack: (scope: { organizationId: string; trackId: string }) => Promise<VariantMusicTrack | undefined>;
  /** Runs fn with the request's ledger. Production uses withReservationLedger, so the reservation is locked while it is read. */
  withLedger: <T>(scope: { organizationId: string; reservationId: string }, fn: (ledger: LedgerStore) => Promise<T>) => Promise<T>;
  /** The learning event stream (events/store.ts). */
  events: EventStore;
  /** The clock, as an ISO time. It becomes the time of each event and each artifact. */
  now: () => string;
};

const REQUEST_TYPE = "production_request";
const PLAN_TYPE = "scene_plan";
const EDL_TYPE = "edl";

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: "variants" });
}

/** The inputs of the stage, parsed. The master is the edl the job names; every other input is refused. */
async function readVariantInputs(sql: Sql, ctx: StageContext): Promise<{ request: ProductionRequest; plan: ScenePlan; master: EditDecisionList; masterStored: StoredArtifact; requestStored: StoredArtifact; planStored: StoredArtifact }> {
  const stored = await readJobInputs(sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const ofType = (type: string): StoredArtifact[] => stored.filter((artifact) => artifact.envelope.type === type);
  const requests = ofType(REQUEST_TYPE);
  const plans = ofType(PLAN_TYPE);
  const edls = ofType(EDL_TYPE);
  if (requests.length !== 1) throw refuse(`the variants stage needs exactly one production_request input, and it has ${requests.length}`);
  if (plans.length !== 1) throw refuse(`the variants stage needs exactly one scene_plan input, and it has ${plans.length}`);
  const requestStored = requests[0];
  const planStored = plans[0];
  if (requestStored === undefined || planStored === undefined) throw refuse("the variants stage is missing its request or its plan");

  const masterId = ctx.payload.details.masterEdlId;
  if (typeof masterId !== "string") throw refuse("the variants stage names no master EDL");
  const masterStored = edls.find((artifact) => (artifact.envelope.body as { edlId?: unknown }).edlId === masterId);
  if (masterStored === undefined) throw refuse(`the master EDL ${masterId} is not among the variants stage's inputs`);

  const request = productionRequestSchema.safeParse(requestStored.envelope.body);
  const plan = scenePlanSchema.safeParse(planStored.envelope.body);
  const master = edlSchema.safeParse(masterStored.envelope.body);
  if (!request.success || !plan.success || !master.success) {
    const bad = [request.success ? null : "production_request", plan.success ? null : "scene_plan", master.success ? null : "edl"].filter(Boolean);
    throw refuse(`the variants inputs do not parse: ${bad.join(", ")}`);
  }
  if (master.data.requestId !== ctx.requestId || plan.data.requestId !== ctx.requestId) throw refuse("a variants input belongs to another request");
  return { request: request.data, plan: plan.data, master: master.data, masterStored, requestStored, planStored };
}

/** The reservation's headroom: what it can still hold after what is committed. A reservation that is not reserved holds nothing. */
async function headroomOf(ports: VariantPorts, organizationId: string, reservationId: string): Promise<number> {
  return ports.withLedger({ organizationId, reservationId }, async (ledger) => {
    const reservation = await ledger.getReservation(reservationId);
    if (reservation === null) throw new EngineError("not_found", `reservation ${reservationId} does not exist`, { stage: "variants" });
    if (reservation.state !== "reserved") return 0;
    const committed = await committedFor(ledger, reservationId);
    return roundUsd(Math.max(0, reservation.reservedUsd - committed));
  });
}

function plannedEvent(
  variant: PlannedVariant | SkippedVariant,
  requestId: string,
  controlEdlId: string,
  status: "built" | "deferred" | "not_built" | "skipped",
  reason: string | null,
): LearningEvent {
  const work = "work" in variant ? variant.work : { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] };
  return {
    kind: "variant.planned",
    stage: "variants",
    subjectId: requestId,
    dedupeKey: `variant-planned:${requestId}:${variant.key}`,
    body: {
      key: variant.key,
      attribute: variant.attribute,
      value: variant.value,
      controlEdlId,
      status,
      reason,
      estimateUsd: variant.estimateUsd,
      work,
    },
  };
}

/** The variants stage. Pass the ports the worker wires (see VariantPorts). */
export function createVariantsHandler(ports: VariantPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const inputs = await readVariantInputs(ctx.sql, ctx);
      const matrix = inputs.request.output.variants;
      if (matrix === undefined) throw refuse("the request names no variant matrix, so it has no variants to make");
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) throw refuse("the variants stage needs its budget reservation (its headroom is read from it); no call is made");

      const trackIds = [...new Set(matrix.music ?? [])];
      const tracks = new Map<string, VariantMusicTrack>();
      for (const trackId of trackIds) {
        const track = await ports.loadMusicTrack({ organizationId: ctx.organizationId, trackId });
        if (track !== undefined) tracks.set(trackId, track);
      }
      const headroomUsd = await headroomOf(ports, ctx.organizationId, reservationId);
      const expansion = expandVariants({ request: inputs.request, plan: inputs.plan, master: inputs.master, matrix, tracks, headroomUsd });

      const at = ports.now();
      const artifacts: Record<string, string> = {};
      const variants: { edlId: string }[] = [];
      const events: LearningEvent[] = [];
      const masterEdlId = inputs.master.edlId;

      for (const variant of expansion.planned) {
        if (variant.build === "generation") {
          events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "deferred", "needs generation: produce_shot, the voice stage or the variant writer, which this stage does not run"));
          continue;
        }
        const built = buildRerenderVariant(inputs.master, variant, variantMusicMix);
        if (built.status === "not_built") {
          events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "not_built", built.reason));
          continue;
        }
        const written = await writeArtifactOnce(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "edl",
          body: built.edl,
          parentIds: [inputs.masterStored.envelope.artifactId, inputs.requestStored.envelope.artifactId, inputs.planStored.envelope.artifactId],
          createdAt: at,
          artifactId: stableId("art_", `variant-edl|${ctx.requestId}|${built.edl.edlId}`),
        });
        artifacts[`edl:${built.edl.edlId}`] = written.artifactId;
        variants.push({ edlId: built.edl.edlId });
        events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "built", null));
      }
      for (const skip of expansion.skipped) {
        events.push(plannedEvent(skip, ctx.requestId, masterEdlId, "skipped", skip.reason));
      }

      await emitLearningEvents(ports.events, { organizationId: ctx.organizationId, requestId: ctx.requestId }, events, {
        at,
        jobId: ctx.jobId,
      });
      return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts, variants } };
    },
  };
}
