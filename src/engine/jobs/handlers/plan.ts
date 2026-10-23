// The `plan` stage handler (Bible 6.4, gate `plan` 12.1). It reads the validated request, the VideoDNA and the voice track (its
// inputs, Bible 5.1), loads the kits the request validated, classifies the visual requests (7.3), and builds the scene plan with
// the planner and the director (plan/build.ts). A built plan is written as a scene_plan artifact, whether or not it passes its gate,
// so the review can show it; only a pass lets the orchestrator advance. A plan that cannot be built writes nothing.
//
// The stage makes paid Claude calls, so it needs its budget reservation on the payload. Without one it refuses (fail closed), since
// no call may be made unreserved (Bible 14.1). Downgrade replans (a directive on the payload) are not built in E3.

import {
  EngineError,
  scenePlanSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type ArtifactType,
  type GateResult,
  type ShotSpec,
  type ValidatedRequest,
} from "../../contracts/index.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { classifyVisualRequests, visualRequestsOf } from "../../plan/classify.ts";
import { planScene, replanDowngrade, type PlanKitBodies } from "../../plan/build.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult, ShotSummary } from "../types.ts";
import { notImplementedError } from "../types.ts";
import type { KitScope, ResolvedKits } from "./intake.ts";
import { scriptOf, writtenScriptOf } from "../../script/resolve.ts";
import type { ModelChoices } from "../../contracts/model-choices.ts";
import type { ModelCatalogSource } from "../../gateway/catalog.ts";
import { chooseModels } from "../../plan/model-choices.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";

/** The request's model_choices artifact id, when one is stored (a request has at most one, contract v8). */
async function modelChoicesArtifactOf(sql: Sql, organizationId: string, requestId: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from engine_artifacts
    where organization_id = ${organizationId} and request_id = ${requestId} and type = 'model_choices'
    order by created_at, id limit 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * The ports the plan stage needs from outside: the kit store (the same port intake uses) and the Claude client's deps for one
 * request. The deps carry that request's role-call journal, so the classification intake already paid for is reused, not paid again.
 */
export type PlanPorts = {
  loadKits: (scope: KitScope) => Promise<ResolvedKits>;
  /** The gateway, the ledger, the clock and the call journal for one request (claude/client.ts RoleDeps). */
  roleDeps: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
  /**
   * OpenRouter's model catalog (gateway/catalog.ts, Bible 10.5). When given, a plan that passes its gate is followed by the request's
   * one model_chooser call (plan/model-choices.ts), and its choices are written as the request's model_choices artifact. Absent, no
   * model is chosen and every call keeps the route table.
   */
  catalog?: ModelCatalogSource;
};

/**
 * The summary the orchestrator plans work from (ShotSummary). The plan body itself is not passed on.
 *
 * A chain (contract v5, Bible 7.1) is summarised by its first call's model class, and it makes one take: its last call's video. A
 * chain that makes its take from several takes, or that ends in an image (stop-motion frames, whose closing component the
 * orchestrator does not place yet), is refused here, before anything is stored, so no plan the pipeline cannot run is kept.
 */
export function shotSummaryOf(shot: ShotSpec): ShotSummary {
  const source = shot.source;
  if (source.kind === "chain") {
    const first = source.calls[0];
    const last = source.calls[source.calls.length - 1];
    if (first === undefined || last === undefined) {
      throw notImplementedError(`${shot.shotId} is a chain with no calls`, "plan");
    }
    if (source.calls.some((call) => call.takes !== 1)) {
      throw notImplementedError(`${shot.shotId} is a chain whose calls take two takes; a chain makes one take`, "plan");
    }
    if (!last.modelClass.startsWith("video.")) {
      throw notImplementedError(
        `${shot.shotId} is a chain that ends in an image; its closing component is not placed by the orchestrator yet, so the shot is refused`,
        "plan",
      );
    }
    return {
      shotId: shot.shotId,
      visualType: shot.visualType,
      downgradeTo: shot.downgradeTo ?? null,
      sourceKind: "chain",
      modelClass: first.modelClass,
      takesWanted: 1,
    };
  }
  return {
    shotId: shot.shotId,
    visualType: shot.visualType,
    downgradeTo: shot.downgradeTo ?? null,
    sourceKind: source.kind,
    modelClass: source.kind === "generate" ? source.modelClass : null,
    takesWanted: source.kind === "generate" ? source.takes : 1,
  };
}

/** The job's infrastructure attempt (Bible 5.1), from its payload. An unreadable attempt is the first. */
function attemptOf(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError("invalid_input", `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`, { stage: ctx.stage });
}

/** Every input artifact of the job, read (Bible 5.1: the job reads only its inputs). */
async function inputArtifacts(ctx: StageContext): Promise<StoredArtifact[]> {
  const stored: StoredArtifact[] = [];
  for (const artifactId of ctx.payload.inputArtifactIds) {
    stored.push(await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId }));
  }
  return stored;
}

/**
 * A replan of one shot, named by the orchestrator's directive (Bible 5.3). Only the downgrade is built: it reads the plan it changes and the
 * plan's inputs, classifies the requests again (the journal reuses the answers already paid for), and replans the named shot. A rewrite is
 * not built, so it is refused as not implemented, never as a success. A replan that cannot be built writes no plan and says why in its gate.
 */
async function runDirectiveReplan(ctx: StageContext, ports: PlanPorts): Promise<StageRunResult> {
  const directive = ctx.payload.details.directive;
  if (directive !== "downgrade") throw notImplementedError(`the ${String(directive)} replan is not built (plan/STATUS.md)`, ctx.stage);
  const shotId = ctx.payload.details.shotId;
  if (typeof shotId !== "string" || shotId.length === 0) {
    throw new EngineError("invalid_input", "a downgrade replan names the shot it changes", { stage: ctx.stage });
  }
  const planStored = await readInputOfType(ctx, "scene_plan");
  const validatedStored = await readInputOfType(ctx, "validated_request");
  const dnaStored = await readInputOfType(ctx, "video_dna");
  const voiceStored = await readInputOfType(ctx, "voice_track");
  const planParsed = scenePlanSchema.safeParse(planStored.envelope.body);
  const validatedParsed = validatedRequestSchema.safeParse(validatedStored.envelope.body);
  const dnaParsed = videoDnaSchema.safeParse(dnaStored.envelope.body);
  const voiceParsed = voiceTrackSchema.safeParse(voiceStored.envelope.body);
  if (!planParsed.success || !validatedParsed.success || !dnaParsed.success || !voiceParsed.success) {
    throw new EngineError("invalid_input", "the replan's input artifacts do not parse", { stage: ctx.stage });
  }
  const reservationId = ctx.payload.budgetReservationId;
  if (reservationId === null) {
    throw new EngineError("invalid_input", "the replan may make a paid planner call, so it needs its budget reservation; no call is made", {
      stage: ctx.stage,
    });
  }
  const validated: ValidatedRequest = validatedParsed.data;
  const request = validated.request;
  const written = writtenScriptOf(await inputArtifacts(ctx), ctx.requestId);
  const script = scriptOf(request, written);
  const kits = await ports.loadKits({ organizationId: ctx.organizationId, request });
  const bodies: PlanKitBodies = {
    ...(kits.styleKit === undefined ? {} : { styleKit: kits.styleKit }),
    ...(kits.persona === undefined ? {} : { persona: kits.persona }),
    ...(kits.productKit === undefined ? {} : { productKit: kits.productKit }),
    characters: [...kits.characters],
  };
  const deps = ports.roleDeps({ organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId });
  const attempt = attemptOf(ctx.payload.attempt);

  const classified = await classifyVisualRequests(deps, {
    requestId: ctx.requestId,
    workspaceId: ctx.organizationId,
    reservationId,
    attempt,
    signal: ctx.signal,
    requests: visualRequestsOf(request),
  });
  if (classified.status === "not_classified") {
    const gate: GateResult = gateResult("plan", ctx.requestId, [check("requests_classified", false, { detail: classified.reason })], [shotId]);
    return { kind: "done", output: { stage: "plan", subjectId: ctx.subjectId, artifacts: {}, gate, shots: [] } };
  }

  const replanned = await replanDowngrade({
    requestId: ctx.requestId,
    workspaceId: ctx.organizationId,
    reservationId,
    attempt,
    signal: ctx.signal,
    request,
    script,
    validated,
    voice: voiceParsed.data,
    dna: dnaParsed.data,
    kits: bodies,
    classifications: classified.classifications,
    deps,
    previous: planParsed.data,
    shotId,
  });
  const artifacts: Record<string, string> = {};
  if (replanned.plan !== null) {
    const newPlan = await writeArtifact(ctx.sql, {
      organizationId: ctx.organizationId,
      requestId: ctx.requestId,
      stage: ctx.stage,
      type: "scene_plan",
      body: replanned.plan,
      parentIds: [planStored.envelope.artifactId, validatedStored.envelope.artifactId, dnaStored.envelope.artifactId, voiceStored.envelope.artifactId],
      createdAt: new Date().toISOString(),
    });
    artifacts.plan = newPlan.artifactId;
  }
  return {
    kind: "done",
    output: {
      stage: "plan",
      subjectId: ctx.subjectId,
      artifacts,
      gate: replanned.gate,
      shots: replanned.shot === null ? [] : [shotSummaryOf(replanned.shot)],
    },
  };
}

/** The plan stage. Pass the ports the worker wires. Missing kits and missing reservations fail closed (see the file header). */
export function createPlanHandler(ports: PlanPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      if (ctx.payload.details.directive !== undefined) return runDirectiveReplan(ctx, ports);
      const validatedStored = await readInputOfType(ctx, "validated_request");
      const dnaStored = await readInputOfType(ctx, "video_dna");
      const voiceStored = await readInputOfType(ctx, "voice_track");
      const validatedParsed = validatedRequestSchema.safeParse(validatedStored.envelope.body);
      const dnaParsed = videoDnaSchema.safeParse(dnaStored.envelope.body);
      const voiceParsed = voiceTrackSchema.safeParse(voiceStored.envelope.body);
      if (!validatedParsed.success || !dnaParsed.success || !voiceParsed.success) {
        const bad = [
          validatedParsed.success ? null : "validated_request",
          dnaParsed.success ? null : "video_dna",
          voiceParsed.success ? null : "voice_track",
        ].filter((name): name is string => name !== null);
        throw new EngineError("invalid_input", `the plan's input artifacts do not parse: ${bad.join(", ")}`, { stage: ctx.stage });
      }
      const validated: ValidatedRequest = validatedParsed.data;
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) {
        throw new EngineError("invalid_input", "the plan makes paid Claude calls, so it needs its budget reservation; no call is made", {
          stage: ctx.stage,
        });
      }

      const request = validated.request;
      // The words the plan covers: the request's script, or the written script of a brief (contract v8). A brief whose script is not
      // among the inputs is an internal error, never an empty plan.
      const written = writtenScriptOf(await inputArtifacts(ctx), ctx.requestId);
      const script = scriptOf(request, written);
      const kits = await ports.loadKits({ organizationId: ctx.organizationId, request });
      const bodies: PlanKitBodies = {
        ...(kits.styleKit === undefined ? {} : { styleKit: kits.styleKit }),
        ...(kits.persona === undefined ? {} : { persona: kits.persona }),
        ...(kits.productKit === undefined ? {} : { productKit: kits.productKit }),
        characters: [...kits.characters],
      };
      const deps = ports.roleDeps({ organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId });
      const attempt = attemptOf(ctx.payload.attempt);

      const classified = await classifyVisualRequests(deps, {
        requestId: ctx.requestId,
        workspaceId: ctx.organizationId,
        reservationId,
        attempt,
        signal: ctx.signal,
        requests: visualRequestsOf(request),
      });
      if (classified.status === "not_classified") {
        const gate: GateResult = gateResult("plan", ctx.requestId, [check("requests_classified", false, { detail: classified.reason })]);
        return { kind: "done", output: { stage: "plan", subjectId: ctx.subjectId, artifacts: {}, gate, shots: [] } };
      }

      const planned = await planScene({
        requestId: ctx.requestId,
        workspaceId: ctx.organizationId,
        reservationId,
        attempt,
        signal: ctx.signal,
        request,
        script,
        validated,
        voice: voiceParsed.data,
        dna: dnaParsed.data,
        kits: bodies,
        classifications: classified.classifications,
        deps,
      });

      const artifacts: Record<string, string> = {};
      let shots: ShotSummary[] = [];
      if (planned.plan !== null) {
        // The summaries refuse a chain the pipeline cannot run (contract v5) before anything is written, so no such plan is stored.
        const summaries = planned.plan.shots.map(shotSummaryOf);
        // The request's model choice (Bible 10.5): one model_chooser call after a plan that passed, before the plan is written, so the
        // plan's decisions record every choice. A request has one model_choices artifact: a retry of this job reuses the stored one.
        let plan = planned.plan;
        let choices: ModelChoices | null = null;
        let existingChoices: string | null = null;
        if (planned.gate.pass && ports.catalog !== undefined) {
          const stored = await modelChoicesArtifactOf(ctx.sql, ctx.organizationId, ctx.requestId);
          if (stored !== null) {
            existingChoices = stored;
          } else {
            const run = await chooseModels({
              deps,
              catalog: ports.catalog,
              requestId: ctx.requestId,
              workspaceId: ctx.organizationId,
              reservationId,
              attempt,
              signal: ctx.signal,
              plan,
            });
            plan = { ...plan, decisions: [...plan.decisions, ...run.decisions] };
            choices = run.choices;
          }
        }
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "scene_plan",
          body: plan,
          parentIds: [validatedStored.envelope.artifactId, dnaStored.envelope.artifactId, voiceStored.envelope.artifactId],
          createdAt: new Date().toISOString(),
        });
        artifacts.plan = written.artifactId;
        if (existingChoices !== null) artifacts.model_choices = existingChoices;
        if (choices !== null) {
          const choicesWritten = await writeArtifact(ctx.sql, {
            organizationId: ctx.organizationId,
            requestId: ctx.requestId,
            stage: ctx.stage,
            type: "model_choices",
            body: choices,
            parentIds: [written.artifactId],
            createdAt: new Date().toISOString(),
          });
          artifacts.model_choices = choicesWritten.artifactId;
        }
        shots = summaries;
      }
      return { kind: "done", output: { stage: "plan", subjectId: ctx.subjectId, artifacts, gate: planned.gate, shots } };
    },
  };
}
