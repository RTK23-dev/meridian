// The `render` stage handler (Video Engine Bible 6.11, 14.1, E5). It renders one composition through the fallback policy in
// render/fallback.ts: HyperFrames twice, then Shotstack for a component-free EDL, else review. The render is paid from the request's
// reservation, so the job carries it (the dispatcher refuses a paid stage without one).
//
// Steps: (1) read the composition, the EDL and the validated request, and check they belong to the request. (2) Recompile the EDL
// with the style kit and check the contentHash equals the stored composition (compose/compiler.ts is deterministic). (3) Run the
// fallback policy with the renderers the composition root gives (their deps carry the ledger, the integrity check, the store and the
// media resolver). (4) Store the render_integrity gate result on every run (pass or fail), and on a pass the rendered_video artifact.
//
// Outcomes:
//   - rendered (HyperFrames or Shotstack): a rendered_video artifact (slot render:<edlId>) and the passing integrity gate (slot
//     integrity:<edlId>). A fallback to Shotstack is a Decision, so the manifest records it (Bible L7).
//   - review: no renderer delivered it (a custom component, or every renderer failed). The integrity gate fails with the rule
//     render_completed, and the orchestrator routes it to review.
// Errors that are not render failures (an invalid composition, a budget refusal, a bug) are thrown: no other renderer spends on them.
//
// A renderer that is not connected is a failed attempt, never a success (Bible 0, rule 1): Shotstack without its deps is a failure
// with the reason, which leads to review.

import { z } from "zod";
import {
  EngineError,
  compositionSchema,
  edlSchema,
  validatedRequestSchema,
  type Decision,
  type EditDecisionList,
  type GateResult,
  type RenderedVideo,
  type StyleKit,
  type ValidatedRequest,
} from "../../contracts/index.ts";
import { compile } from "../../compose/compiler.ts";
import { renderComposition, type IntegrityInput, type RenderDeps, type RenderOutcome } from "../../render/hyperframesCloud.ts";
import { renderWithFallback, type FallbackResult, type RenderFailure } from "../../render/fallback.ts";
import { renderEdlWithShotstack, type ShotstackDeps, type ShotstackRenderOutcome } from "../../render/shotstack.ts";
import { readJobInputs, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageOutput, StageRunResult } from "../types.ts";

export type RenderScope = { organizationId: string; requestId: string; reservationId: string; validated: ValidatedRequest };

/** What the composition root gives the render stage. Each renderer's deps carry its own adapter, ledger, integrity check and store. */
export type RenderPorts = {
  loadStyleKit: (scope: RenderScope) => Promise<StyleKit | undefined>;
  /**
   * The render line of the reservation for a video of this length, in USD. Undefined means the render price is not known, so nothing
   * is rendered (Bible 14.2). Priced per minute, so the duration is part of the question.
   */
  renderEstimateUsd: (scope: RenderScope, durationMs: number) => Promise<number | undefined>;
  /** The HyperFrames cloud deps for this request. */
  hyperframes: (scope: RenderScope) => RenderDeps;
  /** The Shotstack deps for this request. Absent: Shotstack is not connected, so a component-free EDL that HyperFrames failed twice is reviewed. */
  shotstack?: (scope: RenderScope) => ShotstackDeps;
  now: () => string;
};

const STAGE = "render";
const INTEGRITY_GATE = "render_integrity" as const;

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: STAGE });
}

function one(stored: readonly StoredArtifact[], type: string): StoredArtifact {
  const matches = stored.filter((artifact) => artifact.envelope.type === type);
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) throw refuse(`render needs exactly one ${type} input, and it has ${matches.length}`);
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

/** A failing integrity gate. Its one check names the rule that failed, in words the review item can show. */
function failedIntegrity(edlId: string, rule: string, detail: string): GateResult {
  return { gate: INTEGRITY_GATE, subjectId: edlId, pass: false, checks: [{ rule, pass: false, detail }] };
}

/** Wraps a deps' integrity check so the gate it returns is kept: the stage stores the measured result, not a summary of it. */
function recordingIntegrity<D extends { verifyIntegrity: (input: IntegrityInput) => Promise<GateResult> }>(deps: D, captured: GateResult[]): D {
  return {
    ...deps,
    verifyIntegrity: async (input: IntegrityInput) => {
      const gate = await deps.verifyIntegrity(input);
      captured.push(gate);
      return gate;
    },
  };
}

function fallbackDecision(edlId: string, failures: readonly RenderFailure[], dropped: readonly string[]): Decision {
  const hyperframes = failures.filter((failure) => failure.route === "hyperframes").length;
  return {
    at: `edl:${edlId}`,
    chose: "shotstack",
    alternatives: [{ option: "hyperframes", score: 0 }],
    reason:
      `HyperFrames failed ${hyperframes} times (Video Engine Bible 6.11); the component-free EDL goes to Shotstack` +
      (dropped.length > 0 ? `; effects not carried: ${dropped.length}` : ""),
    by: "scorer",
  };
}

/** The render stage. Writes the integrity gate result on every run, and the rendered video on a pass. */
export function createRenderHandler(ports: RenderPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const inputs = await readJobInputs(ctx.sql, {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        inputArtifactIds: ctx.payload.inputArtifactIds,
      });
      const compositionStored = one(inputs, "composition");
      const edlStored = one(inputs, "edl");
      const validatedStored = one(inputs, "validated_request");
      const stored = parseBody(compositionSchema, compositionStored.envelope.body, "composition");
      const edl: EditDecisionList = parseBody(edlSchema, edlStored.envelope.body, "edl");
      const validated: ValidatedRequest = parseBody(validatedRequestSchema, validatedStored.envelope.body, "validated_request");
      if (edl.requestId !== ctx.requestId || validated.requestId !== ctx.requestId) throw refuse("a render input belongs to another request");
      if (ctx.payload.budgetReservationId === null) throw refuse("render is a paid stage and has no budget reservation (Bible 14)");
      const scope: RenderScope = {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        reservationId: ctx.payload.budgetReservationId,
        validated,
      };

      const styleKit = await ports.loadStyleKit(scope);
      if (styleKit === undefined) throw refuse("the style kit did not load, so the composition is not rendered (Bible 13)");
      const compiled = compile(edl, styleKit);
      if (compiled.composition.contentHash !== stored.contentHash) {
        throw refuse("the composition no longer matches its EDL and style kit, so it is not rendered");
      }

      /** Stores the integrity gate (always) and the rendered video (on a pass), and returns the stage output that names them. */
      const finish = async (
        gate: GateResult,
        extra: { video?: RenderedVideo; decisions?: Decision[] } = {},
      ): Promise<StageRunResult> => {
        const artifacts: Record<string, string> = {};
        if (extra.video !== undefined) {
          const written = await writeArtifact(ctx.sql, {
            organizationId: ctx.organizationId,
            requestId: ctx.requestId,
            stage: STAGE,
            type: "rendered_video",
            body: extra.video,
            parentIds: ctx.payload.inputArtifactIds,
            createdAt: ports.now(),
          });
          artifacts[`render:${edl.edlId}`] = written.artifactId;
        }
        const gateWritten = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: STAGE,
          type: "gate_result",
          body: gate,
          parentIds: ctx.payload.inputArtifactIds,
          createdAt: ports.now(),
        });
        artifacts[`integrity:${edl.edlId}`] = gateWritten.artifactId;
        const output: StageOutput = {
          stage: "render",
          subjectId: ctx.subjectId,
          edlId: edl.edlId,
          gate,
          artifacts,
          ...(extra.decisions && extra.decisions.length > 0 ? { decisions: extra.decisions } : {}),
        };
        return { kind: "done", output };
      };

      const renderPrice = await ports.renderEstimateUsd(scope, edl.durationMs);
      if (renderPrice === undefined) {
        return finish(failedIntegrity(edl.edlId, "render_price_known", "the render price is not in the table"));
      }

      const capturedHyperframes: GateResult[] = [];
      const capturedShotstack: GateResult[] = [];
      const hyperframesDeps = recordingIntegrity(ports.hyperframes(scope), capturedHyperframes);
      const shotstackDeps = ports.shotstack ? recordingIntegrity(ports.shotstack(scope), capturedShotstack) : undefined;
      const now = ports.now();

      const result: FallbackResult = await renderWithFallback(edl, {
        hyperframes: async (): Promise<RenderOutcome> =>
          renderComposition(
            {
              requestId: ctx.requestId,
              reservationId: scope.reservationId,
              composition: stored,
              files: compiled.files,
              assets: compiled.assets,
              durationMs: edl.durationMs,
              estimateUsd: renderPrice,
              now,
              title: edl.edlId,
            },
            hyperframesDeps,
          ),
        shotstack: async (): Promise<ShotstackRenderOutcome> => {
          if (shotstackDeps === undefined) {
            throw new EngineError("provider", "Shotstack is not connected, so the component-free EDL has no fallback renderer", {
              retryable: false,
              stage: STAGE,
            });
          }
          return renderEdlWithShotstack(
            { reservationId: scope.reservationId, edl, estimateUsd: renderPrice, now, title: edl.edlId },
            shotstackDeps,
          );
        },
      });

      if (result.status === "review") {
        const reason = result.reason === "custom_components" ? "the EDL uses a custom component Shotstack cannot draw" : "every renderer failed";
        return finish(failedIntegrity(edl.edlId, "render_completed", `no renderer delivered the video: ${reason} (${result.failures.length} failed attempts)`));
      }

      const captured = result.route === "shotstack" ? capturedShotstack : capturedHyperframes;
      const gate = captured.at(-1) ?? failedIntegrity(edl.edlId, "render_integrity_checked", "the render returned no integrity check result");
      if (!gate.pass) return finish(gate);

      const decisions: Decision[] = result.route === "shotstack" ? [fallbackDecision(edl.edlId, result.failures, result.outcome.dropped)] : [];
      return finish(gate, { video: result.outcome.video, decisions });
    },
  };
}
