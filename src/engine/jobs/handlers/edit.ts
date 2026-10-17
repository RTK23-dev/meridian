// The `edit` stage handler (Bible 6.8, gate `edit` 8.3). Pure code: no model call and no provider call. It reads the inputs the
// job names (Bible 5.1): the scene plan, the video DNA, the voice track, the validated request (which names the style kit and
// carries the script's emphasis marks) and the accepted take of each shot. Two things come from ports: the style kit, and
// optionally a music track. It builds the EDL with edit/editor.ts and checks it with edit/rules.ts.
//
// A pass writes the edl artifact, with every input as its parent, and names it edl:<edlId> in the output. A fail writes nothing:
// the gate names the failing checks and shots, and the orchestrator redoes the edit or routes those shots back (Bible 5.3).
// An input that is missing, does not parse, or belongs to another request is an invalid input: a refusal, not a gate result.
// A style kit that does not load is a gate result, so the request does not run on a guessed look (fail closed).

import type { z } from "zod";
import {
  EngineError,
  gateResultSchema,
  scenePlanSchema,
  takeSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type ArtifactType,
  type GateResult,
  type StyleKit,
  type ValidatedRequest,
  type WrittenScript,
} from "../../contracts/index.ts";
import { buildEdl, editIdentity, type EditMusic } from "../../edit/editor.ts";
import type { RuleResult } from "../../edit/rules.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";
import { scriptOf, writtenScriptOf, type ScriptBody } from "../../script/resolve.ts";

/** What a port is given: the workspace, the request, and the validated request the style kit reference comes from. */
export type EditKitScope = { organizationId: string; requestId: string; validated: ValidatedRequest };

/**
 * The ports the stage needs from outside. loadStyleKit is required: an undefined answer, or a kit that is not the version the
 * validated request names, fails the edit gate. loadMusic is optional: without it the EDL has no music, and the build says so.
 */
export type EditPorts = {
  loadStyleKit: (scope: EditKitScope) => Promise<StyleKit | undefined>;
  loadMusic?: (scope: EditKitScope) => Promise<EditMusic | undefined>;
};

type Inputs = {
  plan: StoredArtifact;
  dna: StoredArtifact;
  voice: StoredArtifact;
  validated: StoredArtifact;
  takes: StoredArtifact[];
  /** The written script, when the request is a brief (contract v8). Null for a script request. */
  written: WrittenScript | null;
};

function refuse(message: string, stage: string): EngineError {
  return new EngineError("invalid_input", message, { stage });
}

/** The one input of a type. Missing or repeated, it is refused (the orchestrator passes exactly one of each). */
function oneOf(found: ReadonlyMap<ArtifactType, StoredArtifact[]>, type: ArtifactType, stage: string): StoredArtifact {
  const matches = found.get(type) ?? [];
  if (matches.length !== 1) {
    throw refuse(`${stage} needs exactly one ${type} input, and it has ${matches.length}`, stage);
  }
  const [only] = matches;
  if (only === undefined) throw refuse(`${stage} needs its ${type} input`, stage);
  return only;
}

async function readInputs(ctx: StageContext): Promise<Inputs> {
  const found = new Map<ArtifactType, StoredArtifact[]>();
  const takes: StoredArtifact[] = [];
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === "take") {
      takes.push(stored);
      continue;
    }
    found.set(stored.envelope.type, [...(found.get(stored.envelope.type) ?? []), stored]);
  }
  const written = writtenScriptOf([...found.values()].flat(), ctx.requestId);
  return {
    plan: oneOf(found, "scene_plan", ctx.stage),
    dna: oneOf(found, "video_dna", ctx.stage),
    voice: oneOf(found, "voice_track", ctx.stage),
    validated: oneOf(found, "validated_request", ctx.stage),
    takes,
    written,
  };
}

/** A stored body, parsed against its contract. A body that does not parse is an invalid input (the store already checked it). */
function parseBody<S extends z.ZodType>(schema: S, value: unknown, what: string, stage: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuse(`the ${what} artifact does not parse: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "unknown issue"}`, stage);
  }
  return parsed.data;
}

/** One gate of the edit stage, with its checks in the order the rules ran them. */
export function editGate(subjectId: string, checks: readonly RuleResult[], failingShotIds: readonly string[]): GateResult {
  const parsed = gateResultSchema.safeParse({
    gate: "edit",
    subjectId,
    pass: checks.length > 0 && checks.every((check) => check.pass),
    checks: checks.map((check) => ({
      rule: check.rule,
      pass: check.pass,
      ...(check.value !== undefined ? { value: check.value } : {}),
      ...(check.limit !== undefined ? { limit: check.limit } : {}),
      ...(check.detail !== undefined ? { detail: check.detail } : {}),
    })),
    ...(failingShotIds.length > 0 ? { failingShotIds: [...new Set(failingShotIds)] } : {}),
  });
  if (!parsed.success) {
    throw new EngineError("internal", `the edit gate built an invalid result: ${parsed.error.message}`, { stage: "edit" });
  }
  return parsed.data;
}

/** The emphasis marks the script carries, one per term and beat (Bible 8.2 step 10). The script is the resolved one (script/resolve.ts). */
export function emphasisOf(script: ScriptBody): { beatId: string; term: string }[] {
  return script.beats.flatMap((beat) => (beat.emphasis ?? []).map((term) => ({ beatId: beat.beatId, term })));
}

/** The edit stage. Pass the ports the worker wires; see EditPorts for what an absent port means. */
export function createEditHandler(ports: EditPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const inputs = await readInputs(ctx);
      const plan = parseBody(scenePlanSchema, inputs.plan.envelope.body, "scene_plan", ctx.stage);
      const dna = parseBody(videoDnaSchema, inputs.dna.envelope.body, "video_dna", ctx.stage);
      const voice = parseBody(voiceTrackSchema, inputs.voice.envelope.body, "voice_track", ctx.stage);
      const validated = parseBody(validatedRequestSchema, inputs.validated.envelope.body, "validated_request", ctx.stage);
      const takes = inputs.takes.map((stored) => parseBody(takeSchema, stored.envelope.body, "take", ctx.stage));
      const script = scriptOf(validated.request, inputs.written);

      // The inputs must all belong to this request, and the plan must name the DNA and the voice it was made from.
      const belongs = [plan.requestId, voice.requestId, validated.requestId, validated.request.requestId].every((id) => id === ctx.requestId);
      if (!belongs) throw refuse("an edit input belongs to another request", ctx.stage);
      if (plan.videoDnaId !== dna.videoDnaId) throw refuse("the scene plan was made from another video DNA", ctx.stage);
      if (plan.voiceTrackId !== voice.voiceTrackId) throw refuse("the scene plan was made from another voice track", ctx.stage);

      const parents = ctx.payload.inputArtifactIds;
      const scope: EditKitScope = { organizationId: ctx.organizationId, requestId: ctx.requestId, validated };
      const kitRef = validated.kits.styleKit;
      const kit = await ports.loadStyleKit(scope);
      if (kit === undefined || kit.styleKitId !== kitRef.id || kit.version !== kitRef.version) {
        const reason =
          kit === undefined
            ? `style kit ${kitRef.id} version ${kitRef.version} did not load`
            : `style kit ${kit.styleKitId} version ${kit.version} is not the one the request names (${kitRef.id} version ${kitRef.version})`;
        const { edlId } = editIdentity({ requestId: ctx.requestId, planId: plan.planId, voiceTrackId: voice.voiceTrackId, kitRef });
        const gate = editGate(edlId, [{ rule: "style_kit_loaded", pass: false, detail: reason }], []);
        return { kind: "done", output: { stage: "edit", subjectId: ctx.subjectId, artifacts: {}, gate, edlId } };
      }

      const music = ports.loadMusic === undefined ? undefined : await ports.loadMusic(scope);
      const build = buildEdl({
        requestId: ctx.requestId,
        plan,
        voice,
        grammar: dna.editGrammar,
        referenceDurationMs: dna.durationMs,
        takes,
        kit,
        emphasis: emphasisOf(script),
        ...(music !== undefined ? { music } : {}),
      });
      const gate = editGate(build.edlId, build.checks, build.failingShotIds);

      const artifacts: Record<string, string> = {};
      if (build.pass && build.edl !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "edl",
          body: build.edl,
          parentIds: parents,
          createdAt: new Date().toISOString(),
        });
        artifacts[`edl:${build.edlId}`] = written.artifactId;
      }
      return { kind: "done", output: { stage: "edit", subjectId: ctx.subjectId, artifacts, gate, edlId: build.edlId } };
    },
  };
}
