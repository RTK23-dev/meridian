// The `intake` stage handler (Bible 6.1, gate `request` 12.1). It validates the production request, resolves the kits it
// names, runs the VideoDNA lookup, estimates the spoken length, computes the format minimum (plan/minimum.ts), and runs the
// request gate. A budget below the minimum fails the gate, and the gate's reason names the minimum.
//
// Two parts. decideIntake is pure: the request, the resolved kits, the lookup result and the classifications go in, and the
// gate, the validated request and the minimum come out. createIntakeHandler is the stage: it reads the production_request
// artifact (its only input, Bible 5.1), calls the ports, and writes the validated_request artifact when the gate passes.
//
// Not done here, on purpose: the pre-flight reservation. analyze_reference and voice are paid and run after intake, and the
// orchestrator refuses a passing intake without a reservation id (orchestrator.ts applyIntake), so a passing intake returns
// budgetReservationId null and the request pauses on budget. Whether intake reserves the minimum, and how that hold is
// released at estimate_reserve, is an open decision for the lead. See handlers/STATUS.md.

import {
  EngineError,
  productionRequestSchema,
  validatedRequestSchema,
  type ArtifactType,
  type GateCheck,
  type GateResult,
  type ProductionRequest,
  type ValidatedRequest,
} from "../../contracts/index.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { checkRequest, type RequestGateInput, type VisualClassification } from "../../review/gates/request.ts";
import { minimumMasterBudgetUsd, planKitsOf, spokenBeatMs, type MasterMinimum } from "../../plan/minimum.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/** The kits a request resolved to: the bodies that loaded. A kit that does not exist is absent (the gate reports it). */
export type ResolvedKits = RequestGateInput["kits"];

/** What a port is given: the workspace and the production request it concerns. */
export type KitScope = { organizationId: string; request: ProductionRequest };

/**
 * The ports the stage needs from outside the stage: the kit store, the VideoDNA lookup and the classifier. Each is injected,
 * so the handler never reads a store it was not given. A port that is absent makes its check fail (fail closed):
 * no lookup means the gate's dna_lookup_resolved fails, and no classifier means every must fails its check.
 */
export type IntakePorts = {
  loadKits: (input: KitScope) => Promise<ResolvedKits>;
  /** The VideoDNA lookup (6.1 step 5): the cached dna_ id for this format and reference, or null for a miss. */
  lookupDna?: (input: KitScope) => Promise<string | null>;
  /** The classification of every visual request (7.3). Claude's role for this is not built yet. */
  classify?: (input: KitScope) => Promise<readonly VisualClassification[]>;
};

export type IntakeDecisionInput = {
  /** The production request as stored. Parsed here. */
  request: unknown;
  kits: ResolvedKits;
  /** The lookup result: a dna_ id when cached, null for a miss, undefined when the lookup did not run. */
  videoDnaId: string | null | undefined;
  classifications: readonly VisualClassification[];
};

export type IntakeDecision = {
  gate: GateResult;
  /** The validated request, or null when it cannot be built (a kit did not load, or the speech length is unknown). */
  validated: ValidatedRequest | null;
  /** The format minimum, or null when it cannot be priced. The reason is a failing check on the gate. */
  minimum: MasterMinimum | null;
  /** The spoken length of the script in ms (6.1 step 4), or null when the words per minute are unknown. */
  estimatedSpeechMs: number | null;
};

type Built = { value: ValidatedRequest } | { problem: string };

/** The validated request built from the request and the kits that loaded (6.1 steps 2 and 5). */
function buildValidated(
  request: ProductionRequest,
  kits: ResolvedKits,
  estimatedSpeechMs: number,
  videoDnaId: string | undefined,
): Built {
  if (kits.styleKit === undefined) {
    return { problem: `style kit ${request.page.styleKitId} did not load, so the validated request cannot name it` };
  }
  const characters = (request.page.characterIds ?? []).flatMap((characterId) => {
    const kit = kits.characters.find((item) => item.characterId === characterId);
    return kit === undefined ? [] : [{ id: kit.characterId, version: kit.version }];
  });
  const candidate = {
    schema: "meridian.validated_request/v1",
    requestId: request.requestId,
    request,
    kits: {
      styleKit: { id: kits.styleKit.styleKitId, version: kits.styleKit.version },
      ...(kits.persona !== undefined && request.page.personaId !== undefined
        ? { persona: { id: kits.persona.personaId, version: kits.persona.version } }
        : {}),
      voiceId: request.page.voiceId,
      characters,
      ...(kits.productKit !== undefined && request.product !== undefined
        ? { productKit: { id: kits.productKit.productKitId, version: kits.productKit.version } }
        : {}),
    },
    ...(videoDnaId !== undefined ? { cachedVideoDnaId: videoDnaId } : {}),
    estimatedSpeechMs,
  };
  const parsed = validatedRequestSchema.safeParse(candidate);
  return parsed.success ? { value: parsed.data } : { problem: `the validated request does not parse: ${parsed.error.message}` };
}

/**
 * The intake decision. Pure. Every failure is a failing check with a detail: the request gate's own checks, plus three
 * handler checks when the speech length, the validated request or the minimum cannot be computed. Unknown means fail.
 */
export function decideIntake(input: IntakeDecisionInput): IntakeDecision {
  const parsed = productionRequestSchema.safeParse(input.request);
  let estimatedSpeechMs: number | null = null;
  let validated: ValidatedRequest | null = null;
  let minimum: MasterMinimum | null = null;
  const handlerChecks: GateCheck[] = [];

  if (parsed.success) {
    const request = parsed.data;
    const wordsPerMinute = input.kits.persona?.wordsPerMinute;
    if (wordsPerMinute === undefined) {
      const problem = `voice ${request.page.voiceId} has no words per minute, because its persona did not load; speech length cannot be estimated`;
      handlerChecks.push(check("speech_length_estimated", false, { detail: problem }));
      handlerChecks.push(check("format_minimum_computed", false, { detail: `the minimum needs the speech length: ${problem}` }));
    } else {
      try {
        estimatedSpeechMs = spokenBeatMs(request.script.beats, wordsPerMinute).reduce((sum, ms) => sum + ms, 0);
        handlerChecks.push(check("speech_length_estimated", true));
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        handlerChecks.push(check("speech_length_estimated", false, { detail: error.message }));
      }
      try {
        minimum = minimumMasterBudgetUsd({
          beats: request.script.beats,
          wordsPerMinute,
          visualRequests: request.visualRequests,
          classifications: input.classifications,
          kits: planKitsOf(input.kits),
        });
        handlerChecks.push(check("format_minimum_computed", true));
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        handlerChecks.push(check("format_minimum_computed", false, { detail: error.message }));
      }
    }

    if (estimatedSpeechMs === null) {
      handlerChecks.push(check("validated_request_built", false, { detail: "the speech length is unknown" }));
    } else {
      const built = buildValidated(request, input.kits, estimatedSpeechMs, input.videoDnaId ?? undefined);
      if ("value" in built) {
        validated = built.value;
        handlerChecks.push(check("validated_request_built", true));
      } else {
        handlerChecks.push(check("validated_request_built", false, { detail: built.problem }));
      }
    }
  }

  const gate0 = checkRequest({
    request: input.request,
    validated: validated ?? undefined,
    kits: input.kits,
    dnaLookup: input.videoDnaId === undefined ? undefined : input.videoDnaId === null ? "miss" : "cached",
    formatMinimumUsd: minimum?.minimumUsd,
    classifications: input.classifications,
  });
  // The handler's checks are listed after the gate's own. gateResult recomputes pass, so one failing check fails the gate.
  const gate = gateResult(gate0.gate, gate0.subjectId, [...gate0.checks, ...handlerChecks]);
  return { gate, validated, minimum, estimatedSpeechMs };
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError("invalid_input", `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`, { stage: ctx.stage });
}

/** The intake stage. Pass the ports the worker wires; see IntakePorts for what an absent port means. */
export function createIntakeHandler(ports: IntakePorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const stored = await readInputOfType(ctx, "production_request");
      const parsed = productionRequestSchema.safeParse(stored.envelope.body);
      if (!parsed.success) {
        throw new EngineError("invalid_input", `the production request artifact does not parse: ${parsed.error.message}`, { stage: ctx.stage });
      }
      const request = parsed.data;
      const scope: KitScope = { organizationId: ctx.organizationId, request };
      const kits = await ports.loadKits(scope);
      const videoDnaId = ports.lookupDna === undefined ? undefined : await ports.lookupDna(scope);
      const classifications = ports.classify === undefined ? [] : await ports.classify(scope);

      const decision = decideIntake({ request, kits, videoDnaId, classifications });
      const artifacts: Record<string, string> = {};
      if (decision.gate.pass && decision.validated !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "validated_request",
          body: decision.validated,
          parentIds: [stored.envelope.artifactId],
          createdAt: new Date().toISOString(),
        });
        artifacts.validated = written.artifactId;
      }
      // No reservation on a pass: the pre-flight reservation is the lead's decision (see the header and handlers/STATUS.md).
      return {
        kind: "done",
        output: { stage: "intake", subjectId: ctx.subjectId, artifacts, gate: decision.gate, budgetReservationId: null },
      };
    },
  };
}
