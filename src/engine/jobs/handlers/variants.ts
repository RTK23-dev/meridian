// The `variants` stage handler (Video Engine Bible 6.13, 14.1, 14.3). It runs once the master has passed post-render review, in phases, one job
// each. The orchestrator tells the phases apart by their details.phase.
//
// The request phase (no phase in the details; subject: the request):
// - Expands the variant matrix (variants/expand.ts). It funds the variants that run under the request's reservation before any call
//   (variants/reserve.ts): the hold is raised to the committed spend plus the funded estimates, or the stage refuses and says why.
// - Caption and music variants are EDL diffs of the master. Each is built, checked against its control (variants/diff.ts) and written as an
//   edl artifact that names the master as variantOf.
// - Generation variants (hook, product, persona, language) are not called here. Each one that is funded and whose models are connected
//   becomes an item of the work list, which the orchestrator queues as its own jobs (jobs/variant-runs.ts). Without a connected model, a
//   generation variant is deferred with NOT_CONNECTED and nothing is charged (fail closed).
//
// The phase jobs (subject: the variant's subject, details.phase: writer, voice or plan):
// - writer: the variant writer's call, for the words the variant changes (a hook or a language: its lines; a product: its shot prompts).
// - voice: the voice of the variant's full script (variants/speak.ts). The voice stage's gate decides it.
// - plan: the variant's scene plan, the master's with the references and prompts the change needs (variants/plan.ts). Its shots are
//   produced by the orchestrator's own jobs.
// Each phase checks its connection before any paid call, so a missing model is reported as NOT_CONNECTED with no call. A phase that cannot
// finish marks its variant not_built with the reason, and that variant alone fails. A provider or infrastructure error throws, so the job
// retries.
//
// Every planned, deferred, not-built and skipped variant is written to the learning stream (variant.planned), so the variant plan is on
// record whatever happened to it.
//
// Inputs (the job reads only these, Bible 5.1): the request phase reads the production_request, the scene_plan and the master edl
// (payload.details.masterEdlId); a phase reads the production_request and the scene_plan. The reservation (payload.budgetReservationId) is
// read for its headroom and raised for the funded variants, and each paid call is on it.

import { z } from "zod";
import {
  contentHash,
  EngineError,
  edlSchema,
  productionRequestSchema,
  scenePlanSchema,
  sumUsd,
  takeSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type StyleKit,
  type Take,
  type ValidatedRequest,
  type VideoDNA,
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
import { estimateFor, expandVariants, type PlannedVariant, type SkippedVariant, type VariantMusicTrack } from "../../variants/expand.ts";
import { buildRerenderVariant } from "../../variants/diff.ts";
import { variantMusicMix } from "../../variants/config.ts";
import { extendForVariants } from "../../variants/reserve.ts";
import type { VariantWriterInput } from "../../claude/roles/variant_writer.ts";
import { productPromptsInputFor, writeVariantText, writerInputFor, type WriterChange, type WriterText } from "../../variants/writer.ts";
import { speakVariantScript, runVoiceOverPorts, type VoiceRunner } from "../../variants/speak.ts";
import { personaReferenceOf, productReferenceOf, variantScenePlan } from "../../variants/plan.ts";
import { generationWorkOf, variantWorkItemSchema, VARIANT_PHASES, type VariantWorkItem } from "../../variants/work.ts";
import type { VoicePorts } from "../../voice/voice.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { NOT_CONNECTED, notConnectedReason } from "../../media/stt-connection.ts";
import { assembleVariantEdl, type AssemblyInput } from "../../variants/assemble.ts";
import { editIdentity } from "../../edit/editor.ts";
import { editGate, emphasisOf, type EditKitScope } from "./edit.ts";
import { scriptOf, writtenScriptOf, type ScriptBody } from "../../script/resolve.ts";
import { readJobInputs, type StoredArtifact } from "../artifact-store.ts";
import { stableId } from "../stable-id.ts";
import { writeArtifactOnce } from "../../deliver/write-once.ts";
import type {
  ShotSummary,
  StageContext,
  StageHandler,
  StageOutput,
  StageRunResult,
  VariantPlanOutcome,
  VariantVoiceOutcome,
  VariantWriterOutcome,
} from "../types.ts";

/** The connection of the two generation routes, read before any paid call. A reason is set when the route is not connected. */
export type VariantConnection = { writer: string | null; voice: string | null };

/**
 * The ports of the generation variants (Bible 6.13). Production wires them over the gateway (productionVariantPorts); a test wires them with
 * recorded adapters. Without them, every generation variant is deferred with NOT_CONNECTED.
 */
export type VariantGenerationPorts = {
  /** The Claude client's deps for one request on its reservation: the gateway, the reservation's ledger and the journal. */
  roles: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
  /** Whether the writer's route and the voice are connected, with the reason when not. Read before any paid call. */
  connection: (scope: { organizationId: string }) => Promise<VariantConnection>;
  /** The voice stage's ports (router, speech connection, media, roles, audio). Absent: the voice is not connected unless `speak` is given. */
  voice?: VoicePorts;
  /** Speaks a variant's script. Absent: the voice stage (runVoice) over `voice`. */
  speak?: VoiceRunner;
  /** The product kit of a SKU in this workspace, or undefined. */
  loadProductKit: (scope: { organizationId: string; sku: string }) => Promise<ProductKit | undefined>;
  /** The persona kit of an id in this workspace, or undefined. */
  loadPersona: (scope: { organizationId: string; personaId: string }) => Promise<Persona | undefined>;
  /** The voice kit of an id in this workspace, or undefined. */
  loadVoiceKit: (scope: { organizationId: string; voiceId: string }) => Promise<VoiceKit | undefined>;
};

/** The ports of the variants stage. Production wires them to the music store, the row-locked ledger, the event table and the month budget. */
export type VariantPorts = {
  /** The music track a matrix id names, or undefined when the workspace has no such track. */
  loadMusicTrack: (scope: { organizationId: string; trackId: string }) => Promise<VariantMusicTrack | undefined>;
  /** Runs fn with the request's ledger. Production uses withReservationLedger, so the reservation is locked while it is read or raised. */
  withLedger: <T>(scope: { organizationId: string; reservationId: string }, fn: (ledger: LedgerStore) => Promise<T>) => Promise<T>;
  /** The learning event stream (events/store.ts). */
  events: EventStore;
  /** The clock, as an ISO time. It becomes the time of each event and each artifact. */
  now: () => string;
  /** The workspace's monthly budget for the month of the run, or null when it is not connected: a raise of the reservation is then refused. */
  workspaceMonthBudget?: (scope: { organizationId: string; requestId: string; now: string }) => Promise<number | null>;
  /** The generation ports. Absent: each generation variant is deferred and nothing is charged. */
  generation?: VariantGenerationPorts;
  /**
   * The style kit the validated request names (the edit's own port, Bible 13). An assembly needs it to build the variant's EDL with the same
   * look as the master. An undefined answer, or a kit that is not the version the request names, fails the variant's assembly.
   */
  loadStyleKit: (scope: EditKitScope) => Promise<StyleKit | undefined>;
};

const REQUEST_TYPE = "production_request";
const PLAN_TYPE = "scene_plan";
const EDL_TYPE = "edl";
const PREPARED_REASON = "prepared: its plan and voice are stored, and its takes are queued (variants/STATUS.md)";
const NO_TAKE_REASON = "prepared: its plan and voice are stored; no take is made again for it (variants/STATUS.md)";
const NOT_WIRED = "the generation ports of the variants stage are not wired; no call is made and nothing is charged";

/** The text a writer phase hands to the voice and plan phases. */
const writerTextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lines"), lines: z.array(z.object({ beatId: z.string().min(1), text: z.string().min(1) })) }),
  z.object({ kind: z.literal("prompts"), prompts: z.array(z.object({ shotId: z.string().min(1), text: z.string().min(1) })) }),
]);

/** The details of a phase job, as the orchestrator queues it. They are data the orchestrator wrote, parsed again before use. */
const phaseDetailsSchema = z.object({
  phase: z.enum(VARIANT_PHASES),
  variantKey: z.string().min(1),
  masterEdlId: z.string().min(1),
  work: variantWorkItemSchema,
  text: writerTextSchema.nullable(),
  voiceTrackId: z.string().min(1).nullable(),
});

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: "variants" });
}

/** The inputs of the request phase, parsed. The master is the edl the job names; every other input is refused. */
export type VariantInputs = {
  request: ProductionRequest;
  /** The master's words: the request's script, or a brief's written script (contract v8, script/resolve.ts). */
  script: ScriptBody;
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
  const script = scriptOf(request.data, writtenScriptOf(stored, ctx.requestId));
  return { request: request.data, script, plan: plan.data, master: master.data, masterStored, requestStored, planStored };
}

/** The inputs of a phase job: the request and the master's plan, each exactly one. */
type PhaseInputs = { request: ProductionRequest; script: ScriptBody; plan: ScenePlan; requestStored: StoredArtifact; planStored: StoredArtifact };

async function readPhaseInputs(sql: Sql, ctx: StageContext): Promise<PhaseInputs> {
  const stored = await readJobInputs(sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const requests = stored.filter((artifact) => artifact.envelope.type === REQUEST_TYPE);
  const plans = stored.filter((artifact) => artifact.envelope.type === PLAN_TYPE);
  if (requests.length !== 1 || plans.length !== 1) throw refuse("a variant phase needs exactly one production_request and one scene_plan input");
  const requestStored = requests[0];
  const planStored = plans[0];
  if (requestStored === undefined || planStored === undefined) throw refuse("a variant phase is missing its request or its plan");
  const request = productionRequestSchema.safeParse(requestStored.envelope.body);
  const plan = scenePlanSchema.safeParse(planStored.envelope.body);
  if (!request.success || !plan.success) throw refuse("the variant phase's inputs do not parse");
  if (request.data.requestId !== ctx.requestId || plan.data.requestId !== ctx.requestId) throw refuse("a variant phase input belongs to another request");
  const script = scriptOf(request.data, writtenScriptOf(stored, ctx.requestId));
  return { request: request.data, script, plan: plan.data, requestStored, planStored };
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

/** The variant.planned event of a variant, from its planned row (a caption, music or skipped variant, or a generation one not connected). */
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

/** A generation variant as its event shows it: its work is the work list item (a full re-speak of the voice, not the changed beats). */
function withItemWork(variant: PlannedVariant, item: VariantWorkItem | undefined): PlannedVariant {
  if (item === undefined) return variant;
  return {
    ...variant,
    work: {
      produceShotIds: item.produceShotIds,
      voiceBeatIds: item.voiceBeatIds,
      writerBeatIds: item.writer?.kind === "lines" ? item.writer.beatIds : [],
    },
  };
}

/** The variant.planned event of a generation variant from its work item (a phase's outcome). */
function itemEvent(
  item: VariantWorkItem,
  requestId: string,
  controlEdlId: string,
  status: "built" | "deferred" | "not_built",
  reason: string,
  keyPrefix = "variant-planned",
): LearningEvent {
  return {
    kind: "variant.planned",
    stage: "variants",
    subjectId: requestId,
    dedupeKey: `${keyPrefix}:${requestId}:${item.key}`,
    body: {
      key: item.key,
      attribute: item.attribute,
      value: item.key.slice(item.attribute.length + 1),
      controlEdlId,
      status,
      reason,
      estimateUsd: estimateFor(item.attribute),
      work: {
        produceShotIds: item.produceShotIds,
        voiceBeatIds: item.voiceBeatIds,
        writerBeatIds: item.writer?.kind === "lines" ? item.writer.beatIds : [],
      },
    },
  };
}

function attemptOf(ctx: StageContext): number {
  const parsed = Number(ctx.payload.attempt);
  if (!Number.isInteger(parsed) || parsed < 1) throw refuse(`the job attempt ${ctx.payload.attempt} is not a whole number from 1`);
  return parsed;
}

/** The connection reason of a generation variant's item, when a route it needs is not connected (null: all it needs is connected). */
function unavailableReason(item: VariantWorkItem, connection: VariantConnection): string | null {
  if (item.writer !== null && connection.writer !== null) return connection.writer;
  if (item.voiceBeatIds.length > 0 && connection.voice !== null) return connection.voice;
  return null;
}

/** A NOT_CONNECTED prefix on a reason, added once. */
function asNotConnected(reason: string): string {
  return reason.startsWith(NOT_CONNECTED) ? reason : notConnectedReason(reason);
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

/** The request phase (Bible 6.13): funding, caption and music EDLs, and the work list of the generation variants that can run. */
async function runRequestPhase(ctx: StageContext, ports: VariantPorts): Promise<StageRunResult> {
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
    script: inputs.script,
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

  // Connection (Bible 14.1): each generation variant is checked against the routes its work needs, before anything is funded or called.
  const connection = generation === undefined ? null : await generation.connection({ organizationId: ctx.organizationId });
  const itemOf = new Map<string, VariantWorkItem>();
  for (const variant of expansion.planned) {
    if (variant.build !== "generation") continue;
    const item = generationWorkOf(variant, inputs.script);
    if (item === null) throw refuse(`variant ${variant.key} has no work item`);
    itemOf.set(variant.key, item);
  }
  const blocked = new Map<string, string>();
  const workOf = new Map<string, VariantWorkItem>();
  for (const [key, item] of itemOf) {
    if (generation === undefined || connection === null) {
      blocked.set(key, notConnectedReason(NOT_WIRED));
      continue;
    }
    const reason = unavailableReason(item, connection);
    if (reason !== null) blocked.set(key, asNotConnected(reason));
    else workOf.set(key, item);
  }

  // Funding (Bible 14.1, 6.13). The variants that run are funded under the reservation before any call: the caption and music ones, and
  // the generation ones that are connected. A refusal funds none of them, and the reason is recorded on each.
  const runnable = expansion.planned.filter((variant) => variant.build === "rerender" || workOf.has(variant.key));
  let fundingRefusal: string | null = null;
  if (runnable.length > 0) {
    const monthBudgetUsd =
      ports.workspaceMonthBudget === undefined
        ? null
        : await ports.workspaceMonthBudget({ organizationId: ctx.organizationId, requestId: ctx.requestId, now: at });
    const funding = await ports.withLedger({ organizationId: ctx.organizationId, reservationId }, (ledger) =>
      extendForVariants(ledger, {
        reservationId,
        requestBudgetUsd: inputs.request.constraints.budgetUsd,
        workspaceMonthBudgetUsd: monthBudgetUsd,
        plannedUsd: sumUsd(runnable.map((variant) => variant.estimateUsd)),
        now: at,
      }),
    );
    if (funding.status === "refused") fundingRefusal = funding.reason;
  }

  const artifacts: Record<string, string> = {};
  const variants: { edlId: string }[] = [];
  const work: VariantWorkItem[] = [];
  const events: LearningEvent[] = [];

  for (const variant of expansion.planned) {
    if (variant.build === "generation") {
      const shown = withItemWork(variant, itemOf.get(variant.key));
      const reason = blocked.get(variant.key);
      if (reason !== undefined) {
        events.push(plannedEvent(shown, ctx.requestId, masterEdlId, "deferred", reason));
        continue;
      }
      if (fundingRefusal !== null) {
        events.push(plannedEvent(shown, ctx.requestId, masterEdlId, "skipped", fundingRefusal));
        continue;
      }
      const item = workOf.get(variant.key);
      if (item === undefined) throw refuse(`variant ${variant.key} is funded but has no work item`);
      work.push(item);
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

  await emitLearningEvents(ports.events, { organizationId: ctx.organizationId, requestId: ctx.requestId }, events, { at, jobId: ctx.jobId });
  const output: StageOutput = { stage: "variants", phase: "request", subjectId: ctx.subjectId, artifacts, variants, work };
  return { kind: "done", output };
}

/** The writer's call of one variant (Bible 6.13, 11.1): its lines, or its product prompts. A refused input is not built; a provider error throws. */
async function writerPhase(
  ctx: StageContext,
  generation: VariantGenerationPorts,
  inputs: PhaseInputs,
  item: VariantWorkItem,
  reservationId: string,
  hookCount: number,
): Promise<VariantWriterOutcome> {
  const { request, script, plan } = inputs;
  const organizationId = ctx.organizationId;
  if (item.writer === null) throw refuse(`variant ${item.key} has no writer call`);
  try {
    let input: VariantWriterInput;
    if (item.writer.kind === "lines") {
      let change: WriterChange;
      if (item.change.kind === "hook") change = { kind: "hook", index: item.change.index, count: hookCount };
      else if (item.change.kind === "language") change = { kind: "language", language: item.change.language };
      else return { status: "not_built", reason: `a ${item.change.kind} change writes lines, which it does not` };
      const claims = await approvedClaimsOf(generation, organizationId, request);
      if (claims === null) {
        return { status: "not_built", reason: `the product kit of SKU ${request.product?.sku ?? ""} is not in this workspace, so its approved claims cannot be checked` };
      }
      input = writerInputFor({ script, change, claims });
    } else {
      if (item.change.kind !== "product") return { status: "not_built", reason: `a ${item.change.kind} change writes prompts, which it does not` };
      const kit = await generation.loadProductKit({ organizationId, sku: item.change.sku });
      if (kit === undefined) return { status: "not_built", reason: `the product kit of SKU ${item.change.sku} is not in this workspace` };
      let masterName: string | null = null;
      if (request.product !== undefined) {
        const master = await generation.loadProductKit({ organizationId, sku: request.product.sku });
        if (master === undefined) {
          return { status: "not_built", reason: `the master product's kit (SKU ${request.product.sku}) is not in this workspace, so its name cannot be checked` };
        }
        masterName = master.name;
      }
      const shots = item.writer.shotIds.map((shotId) => {
        const shot = plan.shots.find((candidate) => candidate.shotId === shotId);
        if (shot === undefined || shot.source.kind !== "generate") throw refuse(`shot ${shotId} is not a generated shot of the master plan`);
        return { shotId, prompt: shot.source.prompt };
      });
      input = productPromptsInputFor({ productName: kit.name, masterName, shots, label: `product ${item.change.sku}` });
    }
    const outcome = await writeVariantText(generation.roles({ organizationId, requestId: ctx.requestId, reservationId }), {
      requestId: ctx.requestId,
      workspaceId: organizationId,
      reservationId,
      attempt: attemptOf(ctx),
      input,
    });
    if (outcome.status === "done") return { status: "done", text: outcome.text };
    if (outcome.status === "not_connected") return { status: "not_built", reason: asNotConnected(outcome.reason) };
    return { status: "not_built", reason: `the variant writer did not give text: ${outcome.reason}` };
  } catch (error) {
    // A variant whose input is refused fails alone. A provider or infrastructure error propagates, so the job retries.
    if (error instanceof EngineError && error.kind === "invalid_input") return { status: "not_built", reason: error.message };
    throw error;
  }
}

/** The voice of one variant: its full script, spoken and gated by the voice stage (Bible 6.3, 6.13). Not built on a gate failure. */
async function voicePhase(
  ctx: StageContext,
  generation: VariantGenerationPorts,
  inputs: PhaseInputs,
  item: VariantWorkItem,
  text: WriterText | null,
  reservationId: string,
  at: string,
): Promise<VariantVoiceOutcome> {
  const { request, script } = inputs;
  const organizationId = ctx.organizationId;
  if (generation.voice === undefined && generation.speak === undefined) {
    return { status: "not_built", reason: asNotConnected("the voice stage's ports (speech route, speech-to-text, media, audio) are not wired") };
  }
  let voiceKit: VoiceKit | undefined;
  if (item.change.kind === "persona") {
    const persona = await generation.loadPersona({ organizationId, personaId: item.change.personaId });
    if (persona === undefined) return { status: "not_built", reason: `the persona ${item.change.personaId} is not in this workspace` };
    voiceKit = await generation.loadVoiceKit({ organizationId, voiceId: persona.voiceId });
    if (voiceKit === undefined) {
      return { status: "not_built", reason: `the voice kit ${persona.voiceId} of persona ${item.change.personaId} is not in this workspace` };
    }
  } else {
    voiceKit = await generation.loadVoiceKit({ organizationId, voiceId: request.page.voiceId });
    if (voiceKit === undefined) return { status: "not_built", reason: `the voice kit ${request.page.voiceId} of the page is not in this workspace` };
  }
  const claims = await approvedClaimsOf(generation, organizationId, request);
  if (claims === null) {
    return { status: "not_built", reason: `the product kit of SKU ${request.product?.sku ?? ""} is not in this workspace, so its approved claims cannot be checked` };
  }
  const language = item.change.kind === "language" ? item.change.language : script.language;
  const lines = text !== null && text.kind === "lines" ? text.lines : [];
  const spoken = await speakVariantScript(
    generation.voice,
    {
      organizationId,
      requestId: ctx.requestId,
      reservationId,
      attempt: attemptOf(ctx),
      subject: item.subject,
      request,
      script,
      language,
      voice: voiceKit,
      claims,
      lines,
    },
    generation.speak ?? runVoiceOverPorts,
  );
  if (spoken.status === "not_connected") return { status: "not_built", reason: asNotConnected(spoken.reason) };
  if (!spoken.gate.pass || spoken.track === null) {
    const rules = spoken.gate.checks.filter((check) => !check.pass).map((check) => check.rule);
    return { status: "not_built", reason: `the voice gate did not pass: ${rules.join(", ") || "no check named"}` };
  }
  const track: VoiceTrack = spoken.track;
  const stored = await writeArtifactOnce(ctx.sql, {
    organizationId,
    requestId: ctx.requestId,
    stage: ctx.stage,
    type: "voice_track",
    body: track,
    parentIds: [inputs.requestStored.envelope.artifactId],
    createdAt: at,
    artifactId: stableId("art_", `variant-voice|${ctx.requestId}|${item.key}|${track.voiceTrackId}`),
  });
  return { status: "done", voiceTrackId: track.voiceTrackId, artifacts: { [`voice:${item.key}`]: stored.artifactId } };
}

/** The plan of one variant (Bible 6.13): the master's plan with the references and prompts the change needs, and its produce list. */
async function planPhase(
  ctx: StageContext,
  generation: VariantGenerationPorts,
  inputs: PhaseInputs,
  item: VariantWorkItem,
  details: { text: WriterText | null; voiceTrackId: string | null },
  at: string,
): Promise<VariantPlanOutcome> {
  const organizationId = ctx.organizationId;
  let reference: string | null = null;
  if (item.change.kind === "product") {
    const kit = await generation.loadProductKit({ organizationId, sku: item.change.sku });
    if (kit === undefined) return { status: "not_built", reason: `the product kit of SKU ${item.change.sku} is not in this workspace` };
    reference = productReferenceOf(kit);
    if (reference === null) return { status: "not_built", reason: `the product kit of SKU ${item.change.sku} has no hero image to reference` };
  } else if (item.change.kind === "persona") {
    const persona = await generation.loadPersona({ organizationId, personaId: item.change.personaId });
    if (persona === undefined) return { status: "not_built", reason: `the persona ${item.change.personaId} is not in this workspace` };
    reference = personaReferenceOf(persona);
  }
  const prompts =
    details.text !== null && details.text.kind === "prompts"
      ? Object.fromEntries(details.text.prompts.map((prompt) => [prompt.shotId, prompt.text]))
      : undefined;
  let variant: ReturnType<typeof variantScenePlan>;
  try {
    variant = variantScenePlan(inputs.plan, {
      key: item.key,
      attribute: item.attribute,
      reference,
      shotIds: item.produceShotIds,
      ...(details.voiceTrackId === null ? {} : { voiceTrackId: details.voiceTrackId }),
      ...(prompts === undefined ? {} : { prompts }),
      chose: `${item.attribute} variant ${item.key}`,
    });
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return { status: "not_built", reason: error.message };
    throw error;
  }
  const produce: ShotSummary[] = [];
  for (const shot of variant.plan.shots) {
    if (!item.produceShotIds.includes(shot.shotId)) continue;
    if (shot.source.kind !== "generate") return { status: "not_built", reason: `shot ${shot.shotId} of the variant's plan is not generated` };
    produce.push({
      shotId: shot.shotId,
      visualType: shot.visualType,
      downgradeTo: shot.downgradeTo ?? null,
      sourceKind: "generate",
      modelClass: shot.source.modelClass,
      takesWanted: shot.source.takes,
    });
  }
  const stored = await writeArtifactOnce(ctx.sql, {
    organizationId,
    requestId: ctx.requestId,
    stage: ctx.stage,
    type: "scene_plan",
    body: variant.plan,
    parentIds: [inputs.planStored.envelope.artifactId, inputs.requestStored.envelope.artifactId],
    createdAt: at,
    // The id names the plan's content: a retry writes the same plan under the same id, and a different plan is a different artifact.
    artifactId: stableId("art_", `variant-plan|${ctx.requestId}|${item.key}|${contentHash(variant.plan)}`),
  });
  return { status: "done", artifacts: { [`plan:${item.key}`]: stored.artifactId }, produce };
}

/**
 * Records a phase's learning event: a not_built phase, or a plan that is done (deferred until its takes are made, or until it is assembled
 * when it makes no take). A writer or voice that is done records nothing: its outcome is the next phase's input.
 */
async function settlePhase(
  ports: VariantPorts,
  ctx: StageContext,
  item: VariantWorkItem,
  masterEdlId: string,
  result: { status: "done" | "not_built"; reason?: string },
  plannedDone: { takes: number } | null,
): Promise<void> {
  if (result.status === "not_built") {
    await emit(ports, ctx, [itemEvent(item, ctx.requestId, masterEdlId, "not_built", result.reason ?? "no reason recorded")]);
  } else if (plannedDone !== null) {
    const reason = plannedDone.takes > 0 ? PREPARED_REASON : NO_TAKE_REASON;
    await emit(ports, ctx, [itemEvent(item, ctx.requestId, masterEdlId, "deferred", reason)]);
  }
}

/** One phase job of a generation variant (Bible 6.13). Each phase checks its connection before any paid call (Bible 14.1). */
async function runVariantPhase(ctx: StageContext, ports: VariantPorts, details: PhaseDetails): Promise<StageRunResult> {
  const item = details.work;
  if (item.subject !== ctx.subjectId) throw refuse(`the variant phase is for ${ctx.subjectId}, but its work item is ${item.subject}`);
  const reservationId = ctx.payload.budgetReservationId;
  if (reservationId === null) throw refuse("a variant phase needs its budget reservation; no call is made");
  if (details.phase === "assemble") return runAssemblePhase(ctx, ports, details, item);
  const inputs = await readPhaseInputs(ctx.sql, ctx);
  const at = ports.now();
  const generation = ports.generation;
  const hookCount = inputs.request.output.variants?.hooks ?? 0;
  const key = item.key;

  if (details.phase === "writer") {
    const outcome: VariantWriterOutcome =
      generation === undefined
        ? { status: "not_built", reason: notConnectedReason(NOT_WIRED) }
        : await writerPhase(ctx, generation, inputs, item, reservationId, hookCount);
    await settlePhase(ports, ctx, item, details.masterEdlId, outcome, null);
    return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts: {}, phase: "writer", key, outcome } };
  }
  if (details.phase === "voice") {
    const outcome: VariantVoiceOutcome =
      generation === undefined
        ? { status: "not_built", reason: notConnectedReason(NOT_WIRED) }
        : await voicePhase(ctx, generation, inputs, item, details.text, reservationId, at);
    await settlePhase(ports, ctx, item, details.masterEdlId, outcome, null);
    const artifacts = outcome.status === "done" ? outcome.artifacts : {};
    return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts, phase: "voice", key, outcome } };
  }
  const outcome: VariantPlanOutcome =
    generation === undefined
      ? { status: "not_built", reason: notConnectedReason(NOT_WIRED) }
      : await planPhase(ctx, generation, inputs, item, { text: details.text, voiceTrackId: details.voiceTrackId }, at);
  await settlePhase(ports, ctx, item, details.masterEdlId, outcome, outcome.status === "done" ? { takes: outcome.produce.length } : null);
  const artifacts = outcome.status === "done" ? outcome.artifacts : {};
  return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts, phase: "plan", key, outcome } };
}

function parseOrRefuse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw refuse(`the ${what} of the variant's assembly does not parse`);
  return result.data;
}

/**
 * The assembly of a generation variant (Bible 6.13, variants/assemble.ts): the EDL is built by the editor over the variant's own plan, its
 * voice and the takes its EDL plays, with the same style kit and DNA as the master. The edit gate decides it. A passing build writes the edl
 * artifact, and a failing one writes nothing and fails the variant with the failing checks. Pure code: no call, no charge.
 */
async function runAssemblePhase(ctx: StageContext, ports: VariantPorts, details: PhaseDetails, item: VariantWorkItem): Promise<StageRunResult> {
  const at = ports.now();
  const stored = await readJobInputs(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const ofType = (type: string): StoredArtifact[] => stored.filter((artifact) => artifact.envelope.type === type);
  const one = (type: string): StoredArtifact => {
    const found = ofType(type);
    const [only] = found;
    if (found.length !== 1 || only === undefined) throw refuse(`an assembly needs exactly one ${type} input, and it has ${found.length}`);
    return only;
  };
  const plan = parseOrRefuse(scenePlanSchema, one(PLAN_TYPE).envelope.body, "scene plan");
  const dna: VideoDNA = parseOrRefuse(videoDnaSchema, one("video_dna").envelope.body, "video DNA");
  const voice: VoiceTrack = parseOrRefuse(voiceTrackSchema, one("voice_track").envelope.body, "voice track");
  const validated: ValidatedRequest = parseOrRefuse(validatedRequestSchema, one("validated_request").envelope.body, "validated request");
  const takes: Take[] = ofType("take").map((artifact) => parseOrRefuse(takeSchema, artifact.envelope.body, "take"));
  if (plan.requestId !== ctx.requestId || voice.requestId !== ctx.requestId || validated.requestId !== ctx.requestId) {
    throw refuse("an assembly input belongs to another request");
  }
  // The emphasis marks are the master's words: the request's script, or a brief's written script (contract v8).
  const script = scriptOf(validated.request, writtenScriptOf(stored, ctx.requestId));
  if (plan.videoDnaId !== dna.videoDnaId) throw refuse("the variant's plan was made from another video DNA");
  if (plan.voiceTrackId !== voice.voiceTrackId) throw refuse("the variant's plan was made from another voice track");

  const kitRef = validated.kits.styleKit;
  const kit = await ports.loadStyleKit({ organizationId: ctx.organizationId, requestId: ctx.requestId, validated });
  if (kit === undefined || kit.styleKitId !== kitRef.id || kit.version !== kitRef.version) {
    const reason =
      kit === undefined
        ? `style kit ${kitRef.id} version ${kitRef.version} did not load`
        : `style kit ${kit.styleKitId} version ${kit.version} is not the one the request names (${kitRef.id} version ${kitRef.version})`;
    const { edlId } = editIdentity({ requestId: ctx.requestId, planId: plan.planId, voiceTrackId: voice.voiceTrackId, kitRef });
    const gate = editGate(edlId, [{ rule: "style_kit_loaded", pass: false, detail: reason }], []);
    await emit(ports, ctx, [itemEvent(item, ctx.requestId, details.masterEdlId, "not_built", reason, "variant-assembled")]);
    return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts: {}, phase: "assemble", key: item.key, edlId, gate, outcome: { status: "not_built", reason } } };
  }

  const input: AssemblyInput = {
    requestId: ctx.requestId,
    masterEdlId: details.masterEdlId,
    plan,
    voice,
    dna,
    takes,
    kit,
    emphasis: emphasisOf(script),
  };
  const result = assembleVariantEdl(input);
  const gate = editGate(result.edlId, result.checks, result.failingShotIds);
  if (result.status === "not_built") {
    await emit(ports, ctx, [itemEvent(item, ctx.requestId, details.masterEdlId, "not_built", result.reason, "variant-assembled")]);
    return { kind: "done", output: { stage: "variants", subjectId: ctx.subjectId, artifacts: {}, phase: "assemble", key: item.key, edlId: result.edlId, gate, outcome: { status: "not_built", reason: result.reason } } };
  }
  const written = await writeArtifactOnce(ctx.sql, {
    organizationId: ctx.organizationId,
    requestId: ctx.requestId,
    stage: ctx.stage,
    type: "edl",
    body: result.edl,
    parentIds: ctx.payload.inputArtifactIds,
    createdAt: at,
    artifactId: stableId("art_", `variant-edl|${ctx.requestId}|${result.edlId}`),
  });
  await emit(ports, ctx, [itemEvent(item, ctx.requestId, details.masterEdlId, "built", "assembled: its EDL passed the edit gate", "variant-assembled")]);
  return {
    kind: "done",
    output: {
      stage: "variants",
      subjectId: ctx.subjectId,
      artifacts: { [`edl:${result.edlId}`]: written.artifactId },
      phase: "assemble",
      key: item.key,
      edlId: result.edlId,
      gate,
      outcome: { status: "done" },
    },
  };
}

async function emit(ports: VariantPorts, ctx: StageContext, events: LearningEvent[]): Promise<void> {
  await emitLearningEvents(ports.events, { organizationId: ctx.organizationId, requestId: ctx.requestId }, events, {
    at: ports.now(),
    jobId: ctx.jobId,
  });
}

/** The details of a phase job, parsed. */
type PhaseDetails = z.infer<typeof phaseDetailsSchema>;

/** The variants stage. Pass the ports the worker wires (see VariantPorts). */
export function createVariantsHandler(ports: VariantPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      if (ctx.payload.details.phase === undefined) return runRequestPhase(ctx, ports);
      const details = phaseDetailsSchema.safeParse(ctx.payload.details);
      if (!details.success) throw refuse("the variant phase's details do not parse");
      return runVariantPhase(ctx, ports, details.data);
    },
  };
}
