// The `pre_render_gate` stage handler (Bible 6.10, 12.3). Pure code: no model call, no provider call and no render. It reads the job's
// inputs: the composition and the EDL it checks, and the inputs the checks need (the scene plan, the validated request with the script
// and the kit references, the voice track, the video DNA for the grammar, and the accepted takes). It runs checkPreRender
// (review/gates/preRender.ts) and stores the gate result as a gate_result artifact, pass or fail, so the record exists whatever the
// orchestrator decides (Bible 15.3). The output names the EDL and the gate; the orchestrator routes it.
//
// An input that is missing, repeated, does not parse, or belongs to another request is an invalid input (a refusal, nothing stored).
// Ports that are not connected make their checks not evaluated, which fails them and routes the result to review (Bible 12):
//   - loadStyleKit: required. A kit that did not load fails style_kit_matches_request, so nothing renders on a guessed look.
//   - renderBudget, licensedUris, productImageUris, disclosures: optional, and absent means the check is not evaluated.
// The stage is not paid, so it takes no budget reservation.

import type { z } from "zod";
import {
  EngineError,
  compositionSchema,
  edlSchema,
  scenePlanSchema,
  takeSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type ArtifactType,
  type GateResult,
  type StyleKit,
  type ValidatedRequest,
} from "../../contracts/index.ts";
import { checkPreRender, type RenderBudgetInput } from "../../review/gates/preRender.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import { scriptOf, writtenScriptOf } from "../../script/resolve.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/** What a port is given: the workspace, the request, and the validated request the kit references come from. */
export type PreRenderScope = { organizationId: string; requestId: string; validated: ValidatedRequest };

export type PreRenderPorts = {
  /** The style kit as loaded. Undefined means it did not load, and the gate fails. */
  loadStyleKit: (scope: PreRenderScope) => Promise<StyleKit | undefined>;
  /** The budget left for the render and its estimate. Absent, the budget check is not evaluated. */
  renderBudget?: (scope: PreRenderScope) => Promise<RenderBudgetInput | undefined>;
  /** The media URIs with a licence record for commercial social use. Absent, the rights check is not evaluated. */
  licensedUris?: (scope: PreRenderScope) => Promise<ReadonlySet<string> | undefined>;
  /** The real imagery URIs of the product kit. Absent, the product check is not evaluated. */
  productImageUris?: (scope: PreRenderScope) => Promise<readonly string[] | undefined>;
  /** The AI-presenter disclosure flag the manifest will carry (Bible 6.14). Absent, the disclosure check is not evaluated. */
  disclosures?: (scope: PreRenderScope) => Promise<{ aiGeneratedPeople: boolean } | undefined>;
};

type Found = ReadonlyMap<ArtifactType, StoredArtifact[]>;

function refuse(message: string, stage: string): EngineError {
  return new EngineError("invalid_input", message, { stage });
}

/** The one input of a type. Missing or repeated, it is refused (the orchestrator passes exactly one of each). */
function oneOf(found: Found, type: ArtifactType, stage: string): StoredArtifact {
  const matches = found.get(type) ?? [];
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    throw refuse(`${stage} needs exactly one ${type} input, and it has ${matches.length}`, stage);
  }
  return only;
}

/** A stored body, parsed against its contract. The store checked it already, so a failure here is an input the stage refuses. */
function parseBody<S extends z.ZodType>(schema: S, value: unknown, what: string, stage: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuse(`the ${what} artifact does not parse: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "unknown issue"}`, stage);
  }
  return parsed.data;
}

async function readInputs(ctx: StageContext): Promise<{ found: Found; takes: StoredArtifact[] }> {
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
  return { found, takes };
}

/** The pre_render_gate stage. Writes its gate_result artifact on every run, and returns the gate for the orchestrator to route. */
export function createPreRenderGateHandler(ports: PreRenderPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const stage = ctx.stage;
      const { found, takes: takeArtifacts } = await readInputs(ctx);
      const composition = oneOf(found, "composition", stage);
      const edlStored = oneOf(found, "edl", stage);
      const planStored = oneOf(found, "scene_plan", stage);
      const validatedStored = oneOf(found, "validated_request", stage);
      const voiceStored = oneOf(found, "voice_track", stage);
      const dnaStored = oneOf(found, "video_dna", stage);

      const edl = parseBody(edlSchema, edlStored.envelope.body, "edl", stage);
      const plan = parseBody(scenePlanSchema, planStored.envelope.body, "scene_plan", stage);
      const validated = parseBody(validatedRequestSchema, validatedStored.envelope.body, "validated_request", stage);
      const voice = parseBody(voiceTrackSchema, voiceStored.envelope.body, "voice_track", stage);
      const dna = parseBody(videoDnaSchema, dnaStored.envelope.body, "video_dna", stage);
      const takes = takeArtifacts.map((stored) => parseBody(takeSchema, stored.envelope.body, "take", stage));
      parseBody(compositionSchema, composition.envelope.body, "composition", stage);

      // Every input belongs to this request, and the plan was cut from the DNA and the voice the job names (as edit.ts checks).
      const belongs = [edl.requestId, plan.requestId, voice.requestId, validated.requestId, validated.request.requestId].every((id) => id === ctx.requestId);
      if (!belongs) throw refuse("a pre_render_gate input belongs to another request", stage);
      if (plan.videoDnaId !== dna.videoDnaId) throw refuse("the scene plan was made from another video DNA", stage);
      if (plan.voiceTrackId !== voice.voiceTrackId) throw refuse("the scene plan was made from another voice track", stage);

      // The words the video speaks: the request's script, or a brief's written script (contract v8). Resolved before any check runs.
      const script = scriptOf(validated.request, writtenScriptOf([...found.values()].flat(), ctx.requestId));
      const scope: PreRenderScope = { organizationId: ctx.organizationId, requestId: ctx.requestId, validated };
      const styleKit = await ports.loadStyleKit(scope);
      const renderBudget = ports.renderBudget ? await ports.renderBudget(scope) : undefined;
      const licensedUris = ports.licensedUris ? await ports.licensedUris(scope) : undefined;
      const productImageUris = ports.productImageUris ? await ports.productImageUris(scope) : undefined;
      const disclosures = ports.disclosures ? await ports.disclosures(scope) : undefined;

      const gate: GateResult = checkPreRender({
        edl,
        composition: composition.envelope.body,
        plan,
        validated,
        script,
        voice,
        dna,
        takes,
        styleKit,
        productImageUris,
        disclosures,
        licensedUris,
        renderBudget,
      });

      const parents = ctx.payload.inputArtifactIds;
      const written = await writeArtifact(ctx.sql, {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        stage,
        type: "gate_result",
        body: gate,
        parentIds: parents,
        createdAt: new Date().toISOString(),
      });
      return {
        kind: "done",
        output: {
          stage: "pre_render_gate",
          subjectId: ctx.subjectId,
          artifacts: { [`gate:${edl.edlId}`]: written.artifactId },
          edlId: edl.edlId,
          gate,
        },
      };
    },
  };
}
