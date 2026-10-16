// The `compose` stage handler (Video Engine Bible 6.9, 9.1). Pure code: it compiles the EDL into a HyperFrames composition with the
// style kit the validated request names (compose/compiler.ts). It makes no model call, no provider call and no render, so it takes no
// budget reservation.
//
// It reads the edl and the validated request (the style kit reference), and writes one composition artifact (its body is the
// composition contract; the file bytes are not stored in the artifact). The render stage recompiles the same EDL with the same kit and
// checks that the contentHash matches the stored composition, so a composition that changed after it was stored is refused rather
// than rendered.
//
// A style kit that does not load is an invalid input: nothing is compiled on a guessed look (Bible 13). A compiler refusal (an EDL the
// compiler cannot draw exactly) is thrown as invalid_input, so the job is retried and then dead-lettered with its reason.

import { z } from "zod";
import { EngineError, compositionSchema, edlSchema, validatedRequestSchema, type EditDecisionList, type StyleKit, type ValidatedRequest } from "../../contracts/index.ts";
import { compile } from "../../compose/compiler.ts";
import { readJobInputs, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

export type ComposeScope = { organizationId: string; requestId: string; validated: ValidatedRequest };

export type ComposePorts = {
  /** The style kit the validated request names, as loaded. Undefined means it did not load, and the stage refuses. */
  loadStyleKit: (scope: ComposeScope) => Promise<StyleKit | undefined>;
  now: () => string;
};

const STAGE = "compose";

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: STAGE });
}

function one(stored: readonly StoredArtifact[], type: string): StoredArtifact {
  const matches = stored.filter((artifact) => artifact.envelope.type === type);
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) throw refuse(`compose needs exactly one ${type} input, and it has ${matches.length}`);
  return only;
}

function parseBody<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuse(`the ${what} artifact does not parse: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "unknown issue"}`);
  }
  return parsed.data;
}

/** The compose stage. Writes the composition artifact (slot composition:<edlId>) and returns it for the orchestrator. */
export function createComposeHandler(ports: ComposePorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const inputs = await readJobInputs(ctx.sql, {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        inputArtifactIds: ctx.payload.inputArtifactIds,
      });
      const edlStored = one(inputs, "edl");
      const validatedStored = one(inputs, "validated_request");
      const edl: EditDecisionList = parseBody(edlSchema, edlStored.envelope.body, "edl");
      const validated: ValidatedRequest = parseBody(validatedRequestSchema, validatedStored.envelope.body, "validated_request");
      if (edl.requestId !== ctx.requestId || validated.requestId !== ctx.requestId) throw refuse("a compose input belongs to another request");

      const styleKit = await ports.loadStyleKit({ organizationId: ctx.organizationId, requestId: ctx.requestId, validated });
      if (styleKit === undefined) throw refuse("the style kit did not load, so the EDL is not composed (Bible 13)");

      const compiled = compile(edl, styleKit);
      const composition = parseBody(compositionSchema, compiled.composition, "composition");
      const written = await writeArtifact(ctx.sql, {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        stage: STAGE,
        type: "composition",
        body: composition,
        parentIds: ctx.payload.inputArtifactIds,
        createdAt: ports.now(),
      });
      return {
        kind: "done",
        output: {
          stage: "compose",
          subjectId: ctx.subjectId,
          edlId: edl.edlId,
          artifacts: { [`composition:${edl.edlId}`]: written.artifactId },
        },
      };
    },
  };
}
