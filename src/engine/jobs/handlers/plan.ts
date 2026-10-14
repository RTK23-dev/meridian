// The `plan` stage handler (Bible 6.4, gate `plan` 12.1). It reads the validated request, the VideoDNA and the voice track (its
// inputs, Bible 5.1), loads the kits the request validated, classifies the visual requests (7.3), and builds the scene plan with
// the planner and the director (plan/build.ts). A built plan is written as a scene_plan artifact, whether or not it passes its gate,
// so the review can show it; only a pass lets the orchestrator advance. A plan that cannot be built writes nothing.
//
// The stage makes paid Claude calls, so it needs its budget reservation on the payload. Without one it refuses (fail closed), since
// no call may be made unreserved (Bible 14.1). Downgrade replans (a directive on the payload) are not built in E3.

import {
  EngineError,
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
import { planScene, type PlanKitBodies } from "../../plan/build.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult, ShotSummary } from "../types.ts";
import { notImplementedError } from "../types.ts";
import type { KitScope, ResolvedKits } from "./intake.ts";

/** The ports the plan stage needs from outside: the kit store (the same port intake uses) and the Claude client's deps per workspace. */
export type PlanPorts = {
  loadKits: (scope: KitScope) => Promise<ResolvedKits>;
  /** The gateway, the ledger, the clock and the call journal for one workspace (claude/client.ts RoleDeps). */
  roleDeps: (organizationId: string) => RoleDeps;
};

/** The summary the orchestrator plans work from (ShotSummary). The plan body itself is not passed on. */
export function shotSummaryOf(shot: ShotSpec): ShotSummary {
  const source = shot.source;
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

/** The plan stage. Pass the ports the worker wires. Missing kits and missing reservations fail closed (see the file header). */
export function createPlanHandler(ports: PlanPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      if (ctx.payload.details.directive !== undefined) {
        throw notImplementedError("the downgrade replan is not built in E3 (plan/STATUS.md)", ctx.stage);
      }
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
      const kits = await ports.loadKits({ organizationId: ctx.organizationId, request });
      const bodies: PlanKitBodies = {
        ...(kits.styleKit === undefined ? {} : { styleKit: kits.styleKit }),
        ...(kits.persona === undefined ? {} : { persona: kits.persona }),
        ...(kits.productKit === undefined ? {} : { productKit: kits.productKit }),
        characters: [...kits.characters],
      };
      const deps = ports.roleDeps(ctx.organizationId);
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
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "scene_plan",
          body: planned.plan,
          parentIds: [validatedStored.envelope.artifactId, dnaStored.envelope.artifactId, voiceStored.envelope.artifactId],
          createdAt: new Date().toISOString(),
        });
        artifacts.plan = written.artifactId;
        shots = planned.plan.shots.map(shotSummaryOf);
      }
      return { kind: "done", output: { stage: "plan", subjectId: ctx.subjectId, artifacts, gate: planned.gate, shots } };
    },
  };
}
