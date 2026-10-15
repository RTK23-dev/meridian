// The `variants` stage handler (Video Engine Bible 6.13, 14.1, 14.3). It runs once the master has passed post-render review. It reads the
// production request (the variant matrix), the scene plan (which shots are product, presenter and hook shots) and the master EDL, and
// expands the matrix into planned variants (variants/expand.ts). Then:
//
// - Funding. The variants that run here are funded under the request's reservation before any call (variants/reserve.ts): the hold is
//   raised to the committed spend plus what they need, or the stage refuses to raise it and says why. deliver releases what they do not
//   spend.
// - Caption and music variants are EDL diffs of the master. Each is built, checked against its control (variants/diff.ts) and written
//   as an edl artifact that names the master as variantOf. The orchestrator then runs compose, pre-render, render and review for each.
// - Generation variants (hook, product, persona, language) run when the generation ports are wired (VariantPorts.generation). Each one is
//   prepared, in turn: the writer writes the new lines (hook and language, one call), the voice speaks the changed lines only (a
//   beat-scoped call), and the variant's plan swaps the references of the shots it touches. Its plan and voice are stored as artifacts.
//   Without the ports, a generation variant is deferred and nothing is charged (fail closed).
//
// A generation variant is not built here: its EDL needs its new takes, which produce_shot makes in later jobs, and its voice segment needs
// an audio splice (variants/STATUS.md). Every planned, deferred, skipped and unbuilt variant is written to the learning stream
// (variant.planned), so the request's variant plan is on record whether or not a variant was built. A variant that cannot be built fails
// alone; the stage does not fail for it.
//
// Inputs (the job reads only these, Bible 5.1): the production_request, the scene_plan, and the master edl (payload.details.masterEdlId).
// The orchestrator passes the request and the plan with the master (slots "request", "plan" and "edl:<master>", E4 pass): the stage
// refuses without them. The reservation (payload.budgetReservationId) is read for its headroom and raised for the funded variants.

import {
  contentHash,
  EngineError,
  edlSchema,
  productionRequestSchema,
  scenePlanSchema,
  sumUsd,
  type EditDecisionList,
  type Persona,
  type ProductKit,
  type ProductionRequest,
  type ScenePlan,
  type VoiceKit,
  type VoiceTrack,
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
import { extendForVariants } from "../../variants/reserve.ts";
import { writeVariantLines, writerInputFor, type WriterChange } from "../../variants/writer.ts";
import { speakChangedLines, type ChangedLine, type VoiceRunner } from "../../variants/speak.ts";
import { personaReferenceOf, productReferenceOf, variantScenePlan } from "../../variants/plan.ts";
import { runVoice, type VoicePorts } from "../../voice/voice.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { NOT_CONNECTED, notConnectedReason } from "../../media/stt-connection.ts";
import { readJobInputs, type StoredArtifact } from "../artifact-store.ts";
import { stableId } from "../stable-id.ts";
import { writeArtifactOnce } from "../../deliver/write-once.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/**
 * The ports of the generation variants (Bible 6.13). Production does not wire them yet, so a generation variant is deferred. A test wires
 * them with recorded adapters.
 */
export type VariantGenerationPorts = {
  /** The Claude client's deps for one request on its reservation: the gateway, the reservation's ledger and the journal. */
  roles: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
  /** The voice stage's ports (router, speech connection, media, roles, audio loader). */
  voice: VoicePorts;
  /** Speaks the changed lines. Absent means the voice stage (runVoice). */
  speak?: VoiceRunner;
  /** The product kit of a SKU in this workspace, or undefined. */
  loadProductKit: (scope: { organizationId: string; sku: string }) => Promise<ProductKit | undefined>;
  /** The persona kit of an id in this workspace, or undefined. */
  loadPersona: (scope: { organizationId: string; personaId: string }) => Promise<Persona | undefined>;
  /** The voice kit of an id in this workspace, or undefined. */
  loadVoiceKit: (scope: { organizationId: string; voiceId: string }) => Promise<VoiceKit | undefined>;
};

/** The ports of the variants stage. Production wires them to the music store, the row-locked ledger and the event table. */
export type VariantPorts = {
  /** The music track a matrix id names, or undefined when the workspace has no such track. */
  loadMusicTrack: (scope: { organizationId: string; trackId: string }) => Promise<VariantMusicTrack | undefined>;
  /** Runs fn with the request's ledger. Production uses withReservationLedger, so the reservation is locked while it is read or raised. */
  withLedger: <T>(scope: { organizationId: string; reservationId: string }, fn: (ledger: LedgerStore) => Promise<T>) => Promise<T>;
  /** The learning event stream (events/store.ts). */
  events: EventStore;
  /** The clock, as an ISO time. It becomes the time of each event and each artifact. */
  now: () => string;
  /** The workspace's monthly budget for the month of the run. Absent (not connected): a raise of the reservation is refused. */
  workspaceMonthBudgetUsd?: number;
  /** The generation ports. Absent: each generation variant is deferred and nothing is charged. */
  generation?: VariantGenerationPorts;
};

const REQUEST_TYPE = "production_request";
const PLAN_TYPE = "scene_plan";
const EDL_TYPE = "edl";
const PREPARED_REASON = "prepared: its plan and voice are stored; its EDL is not built until the assembly stage is wired (variants/STATUS.md)";

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: "variants" });
}

/** The inputs of the stage, parsed. The master is the edl the job names; every other input is refused. */
export type VariantInputs = {
  request: ProductionRequest;
  plan: ScenePlan;
  master: EditDecisionList;
  masterStored: StoredArtifact;
  requestStored: StoredArtifact;
  planStored: StoredArtifact;
};

async function readVariantInputs(sql: Sql, ctx: StageContext): Promise<VariantInputs> {
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

/** What the reservation has room for: its headroom (held, not yet committed) and how far the request budget lets it grow. */
type Room = { headroomUsd: number; extendableUsd: number };

async function roomOf(ports: VariantPorts, organizationId: string, reservationId: string, requestBudgetUsd: number): Promise<Room> {
  return ports.withLedger({ organizationId, reservationId }, async (ledger) => {
    const reservation = await ledger.getReservation(reservationId);
    if (reservation === null) throw new EngineError("not_found", `reservation ${reservationId} does not exist`, { stage: "variants" });
    if (reservation.state !== "reserved") return { headroomUsd: 0, extendableUsd: 0 };
    const committed = await committedFor(ledger, reservationId);
    return {
      headroomUsd: roundUsd(Math.max(0, reservation.reservedUsd - committed)),
      extendableUsd: roundUsd(Math.max(0, requestBudgetUsd - reservation.reservedUsd)),
    };
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

type Prepared = { status: "prepared"; artifacts: Record<string, string> } | { status: "not_prepared"; reason: string };

const notPrepared = (reason: string): Prepared => ({ status: "not_prepared", reason });

function attemptOf(ctx: StageContext): number {
  const parsed = Number(ctx.payload.attempt);
  if (!Number.isInteger(parsed) || parsed < 1) throw refuse(`the job attempt ${ctx.payload.attempt} is not a whole number from 1`);
  return parsed;
}

/**
 * The approved claim texts of the request's product, which a writer or a narration may make and no more. Null when the request names a
 * product whose kit is not in the workspace: then nothing is written, since the claims cannot be checked (fail closed).
 */
async function approvedClaimsOf(generation: VariantGenerationPorts, organizationId: string, request: ProductionRequest): Promise<string[] | null> {
  if (request.product === undefined) return [];
  const kit = await generation.loadProductKit({ organizationId, sku: request.product.sku });
  if (kit === undefined) return null;
  const wanted = new Set(request.product.claimIds);
  return kit.approvedClaims.filter((claim) => wanted.has(claim.claimId)).map((claim) => claim.text);
}

/**
 * Prepares one generation variant (Bible 6.13). Reads the kits it needs, makes the writer's call (hook and language), speaks the changed
 * lines (every line for a persona, the new lines otherwise), builds the variant's plan, and stores the plan and the voice. Each call is on
 * the request's reservation, which the stage has already funded. A variant whose kit, writer or voice does not give a usable result is
 * not prepared, with the reason; nothing else is written for it.
 */
async function prepareGeneration(
  ctx: StageContext,
  ports: VariantPorts,
  generation: VariantGenerationPorts,
  inputs: VariantInputs,
  variant: PlannedVariant,
  reservationId: string,
  hookCount: number,
): Promise<Prepared> {
  const { request } = inputs;
  const organizationId = ctx.organizationId;
  const scope = { organizationId, requestId: ctx.requestId, reservationId };
  const change = variant.change;
  try {
    let reference: string | null = null;
    let voiceKit: VoiceKit | undefined;
    let speechLanguage = request.script.language;
    let lines: ChangedLine[] = [];
    let writerChange: WriterChange | null = null;
    const needsVoice = change.kind !== "product";

    if (change.kind === "product") {
      const kit = await generation.loadProductKit({ organizationId, sku: change.sku });
      if (kit === undefined) return notPrepared(`the product kit of SKU ${change.sku} is not in this workspace`);
      reference = productReferenceOf(kit);
      if (reference === null) return notPrepared(`the product kit of SKU ${change.sku} has no hero image to reference`);
    } else if (change.kind === "persona") {
      const persona = await generation.loadPersona({ organizationId, personaId: change.personaId });
      if (persona === undefined) return notPrepared(`the persona ${change.personaId} is not in this workspace`);
      reference = personaReferenceOf(persona);
      voiceKit = await generation.loadVoiceKit({ organizationId, voiceId: persona.voiceId });
      if (voiceKit === undefined) return notPrepared(`the voice kit ${persona.voiceId} of persona ${change.personaId} is not in this workspace`);
      lines = request.script.beats.map((beat) => ({ beatId: beat.beatId, text: beat.text }));
    } else if (change.kind === "hook" || change.kind === "language") {
      writerChange = change.kind === "hook" ? { kind: "hook", index: change.index, count: hookCount } : { kind: "language", language: change.language };
      if (change.kind === "language") speechLanguage = change.language;
      voiceKit = await generation.loadVoiceKit({ organizationId, voiceId: request.page.voiceId });
      if (voiceKit === undefined) return notPrepared(`the voice kit ${request.page.voiceId} of the page is not in this workspace`);
    } else {
      return notPrepared(`a ${change.kind} change is not a generation variant`);
    }

    let claims: string[] = [];
    if (needsVoice) {
      const loaded = await approvedClaimsOf(generation, organizationId, request);
      if (loaded === null) return notPrepared(`the product kit of SKU ${request.product?.sku ?? ""} is not in this workspace, so its approved claims cannot be checked`);
      claims = loaded;
    }

    if (writerChange !== null) {
      const written = await writeVariantLines(generation.roles(scope), {
        requestId: ctx.requestId,
        workspaceId: organizationId,
        reservationId,
        attempt: attemptOf(ctx),
        input: writerInputFor({ request, change: writerChange, claims }),
      });
      if (written.status !== "done") return notPrepared(`the variant writer did not give lines: ${written.reason}`);
      lines = written.lines;
    }

    let spokenTrack: VoiceTrack | null = null;
    if (needsVoice && voiceKit !== undefined) {
      const spoken = await speakChangedLines(
        generation.voice,
        {
          organizationId,
          requestId: ctx.requestId,
          reservationId,
          attempt: attemptOf(ctx),
          subjectId: ctx.subjectId,
          request,
          language: speechLanguage,
          voice: voiceKit,
          claims,
          lines,
        },
        generation.speak ?? runVoice,
      );
      if (spoken.status === "not_connected") {
        return notPrepared(spoken.reason.startsWith(NOT_CONNECTED) ? spoken.reason : notConnectedReason(spoken.reason));
      }
      if (!spoken.gate.pass || spoken.track === null) {
        const rules = spoken.gate.checks.filter((check) => !check.pass).map((check) => check.rule);
        return notPrepared(`the voice gate did not pass: ${rules.join(", ") || "no check named"}`);
      }
      spokenTrack = spoken.track;
    }

    const variantPlan = variantScenePlan(inputs.plan, {
      key: variant.key,
      attribute: change.kind,
      reference,
      shotIds: variant.work.produceShotIds,
      ...(spokenTrack === null ? {} : { voiceTrackId: spokenTrack.voiceTrackId }),
      chose: variant.key,
    });

    const artifacts: Record<string, string> = {};
    const at = ports.now();
    const planStored = await writeArtifactOnce(ctx.sql, {
      organizationId,
      requestId: ctx.requestId,
      stage: ctx.stage,
      type: "scene_plan",
      body: variantPlan.plan,
      parentIds: [inputs.planStored.envelope.artifactId, inputs.requestStored.envelope.artifactId],
      createdAt: at,
      // The id names the plan's content: a retry writes the same plan under the same id, and a different plan is a different artifact
      // (artifacts are immutable, Bible 5.2), never an overwrite.
      artifactId: stableId("art_", `variant-plan|${ctx.requestId}|${variant.key}|${contentHash(variantPlan.plan)}`),
    });
    artifacts[`plan:${variant.key}`] = planStored.artifactId;
    if (spokenTrack !== null) {
      const voiceStored = await writeArtifactOnce(ctx.sql, {
        organizationId,
        requestId: ctx.requestId,
        stage: ctx.stage,
        type: "voice_track",
        body: spokenTrack,
        parentIds: [inputs.requestStored.envelope.artifactId],
        createdAt: at,
        artifactId: stableId("art_", `variant-voice|${ctx.requestId}|${variant.key}|${spokenTrack.voiceTrackId}`),
      });
      artifacts[`voice:${variant.key}`] = voiceStored.artifactId;
    }
    return { status: "prepared", artifacts };
  } catch (error) {
    // A variant that cannot be prepared fails alone. A provider or infrastructure error is not one: it propagates, so the job retries.
    if (error instanceof EngineError && error.kind === "invalid_input") return notPrepared(error.message);
    throw error;
  }
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
      const room = await roomOf(ports, ctx.organizationId, reservationId, inputs.request.constraints.budgetUsd);
      const expansion = expandVariants({
        request: inputs.request,
        plan: inputs.plan,
        master: inputs.master,
        matrix,
        tracks,
        headroomUsd: room.headroomUsd,
        extendableUsd: room.extendableUsd,
      });

      const at = ports.now();
      const generation = ports.generation;
      const masterEdlId = inputs.master.edlId;

      // Funding (Bible 14.1, 6.13). The variants that run here are funded under the reservation before any call: the caption and music
      // ones, and the generation ones when their ports are wired. A refusal funds none of them, and the reason is recorded on each.
      const runnable = expansion.planned.filter((variant) => variant.build === "rerender" || generation !== undefined);
      let fundingRefusal: string | null = null;
      if (runnable.length > 0) {
        const funding = await ports.withLedger({ organizationId: ctx.organizationId, reservationId }, (ledger) =>
          extendForVariants(ledger, {
            reservationId,
            requestBudgetUsd: inputs.request.constraints.budgetUsd,
            workspaceMonthBudgetUsd: ports.workspaceMonthBudgetUsd ?? null,
            plannedUsd: sumUsd(runnable.map((variant) => variant.estimateUsd)),
            now: at,
          }),
        );
        if (funding.status === "refused") fundingRefusal = funding.reason;
      }

      const artifacts: Record<string, string> = {};
      const variants: { edlId: string }[] = [];
      const events: LearningEvent[] = [];

      for (const variant of expansion.planned) {
        if (variant.build === "generation") {
          if (generation === undefined) {
            events.push(
              plannedEvent(variant, ctx.requestId, masterEdlId, "deferred", notConnectedReason("the generation ports of the variants stage are not wired; no call is made and nothing is charged")),
            );
            continue;
          }
          if (fundingRefusal !== null) {
            events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "skipped", fundingRefusal));
            continue;
          }
          const prepared = await prepareGeneration(ctx, ports, generation, inputs, variant, reservationId, matrix.hooks ?? 0);
          if (prepared.status === "not_prepared") {
            events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "not_built", prepared.reason));
            continue;
          }
          Object.assign(artifacts, prepared.artifacts);
          events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "deferred", PREPARED_REASON));
          continue;
        }
        if (fundingRefusal !== null) {
          events.push(plannedEvent(variant, ctx.requestId, masterEdlId, "skipped", fundingRefusal));
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
