// The `intake` stage handler (Bible 6.1, gate `request` 12.1). It validates the production request, resolves the kits it
// names, runs the VideoDNA lookup, estimates the spoken length, computes the format minimum (plan/minimum.ts), and runs the
// request gate. A budget below the minimum fails the gate, and the gate's reason names the minimum.
//
// Money (Bible 6.1 step 8, E3 lead decision 1). The paid stages after intake (analyze_reference, voice, plan) and the intake
// classifier run on a pre-flight hold: budgets.fixedPerMasterUsd, reserved by reserveFixed (budget/preflight.ts) once the
// request's own checks pass. estimate_reserve later raises that same reservation to the plan's estimate. A hold that cap mode
// pauses, or a workspace month that is not connected, pauses the request with the reason (budgetPause): nothing is called.
// A request that is rejected releases its hold, so no budget stays held for it.
//
// The classifier (7.3) runs only for the `must` requests, and only after the hold exists, because its call is paid.
//
// decideIntake is pure: the request, the resolved kits, the lookup result and the classifications go in, and the gate, the
// validated request and the minimum come out. createIntakeHandler is the stage: it reads the production_request artifact (its
// only input, Bible 5.1), reserves, classifies, calls decideIntake, and writes the validated_request artifact on a pass.

import { createHash } from "node:crypto";
import { budgets } from "../../config/budgets.ts";
import {
  EngineError,
  encodeUlid,
  productionRequestSchema,
  sumUsd,
  validatedRequestSchema,
  type ArtifactType,
  type GateCheck,
  type GateResult,
  type ProductionRequest,
  type ValidatedRequest,
} from "../../contracts/index.ts";
import type { RoleDeps } from "../../claude/client.ts";
import { fixedBudgetLines } from "../../budget/estimate.ts";
import { reserveFixed } from "../../budget/preflight.ts";
import { releaseReservation } from "../../budget/reconcile.ts";
import { usdAtMost } from "../../plan/cost.ts";
import { classifyVisualRequests, visualRequestsOf, type VisualRequestRef } from "../../plan/classify.ts";
import { check, gateResult } from "../../review/gates/common.ts";
import { checkRequest, type RequestGateInput, type VisualClassification } from "../../review/gates/request.ts";
import { minimumMasterBudgetUsd, planKitsOf, spokenBeatMs, type MasterMinimum } from "../../plan/minimum.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import { withWorkspaceLedger } from "../sql-ledger-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";
import type { WorkspaceBudgetSource, WorkspaceMonthBudget } from "./estimate-reserve.ts";

/** The kits a request resolved to: the bodies that loaded. A kit that does not exist is absent (the gate reports it). */
export type ResolvedKits = RequestGateInput["kits"];

/** What a port is given: the workspace and the production request it concerns. */
export type KitScope = { organizationId: string; request: ProductionRequest };

/**
 * The ports the stage needs from outside the stage. Each is injected, so the handler never reads a store it was not given.
 * An absent port fails closed: no lookup means dna_lookup_resolved fails; no roleDeps means a must request cannot be classified,
 * so intake refuses it; no workspaceBudget means the monthly budget is not connected, so intake pauses and reserves nothing.
 */
export type IntakePorts = {
  loadKits: (input: KitScope) => Promise<ResolvedKits>;
  /** The VideoDNA lookup (6.1 step 5): the cached dna_ id for this format and reference, or null for a miss. */
  lookupDna?: (input: KitScope) => Promise<string | null>;
  /** The workspace's monthly budget for the pre-flight hold (Bible 14.1 step 2). */
  workspaceBudget?: WorkspaceBudgetSource;
  /**
   * The Claude client's deps for this request on its reservation, with the request's role-call journal (7.3, claude/client.ts).
   * The ledger must be the reservation's lockable ledger, so the classifier's budget steps are serialized.
   */
  roleDeps?: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
};

export type IntakeDecisionInput = {
  /** The production request as stored. Parsed here. */
  request: unknown;
  kits: ResolvedKits;
  /** The lookup result: a dna_ id when cached, null for a miss, undefined when the lookup did not run. */
  videoDnaId: string | null | undefined;
  /** The classification of every must request (7.3). Empty when there is none, or when the classifier did not run. */
  classifications: readonly VisualClassification[];
  /** Why the classifier did not run for a request that needs it. The must check then fails with this reason. */
  classifierProblem?: string;
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

/** The request gate's checks that need the classifier (7.3) or the minimum that uses it. Before the hold they are not run. */
const CLASSIFIER_RULES = new Set(["every_must_deliverable", "budget_above_format_minimum", "format_minimum_computed", "requests_classified"]);

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
 * The intake decision. Pure. Every failure is a failing check with a detail: the request gate's own checks, plus handler checks
 * when the speech length, the validated request, the minimum or the classification cannot be computed. Unknown means fail.
 */
export function decideIntake(input: IntakeDecisionInput): IntakeDecision {
  const parsed = productionRequestSchema.safeParse(input.request);
  let estimatedSpeechMs: number | null = null;
  let validated: ValidatedRequest | null = null;
  let minimum: MasterMinimum | null = null;
  const handlerChecks: GateCheck[] = [];

  if (parsed.success) {
    const request = parsed.data;
    // A budget below the fixed per-master lines cannot hold even the pre-flight hold, so it is refused before any money moves.
    // The fixed lines are part of the minimum (Bible 14.2), so this refusal is the minimum's own refusal, stated early.
    const fixedUsd = sumUsd(fixedBudgetLines().map((line) => line.estimateUsd));
    const covers = usdAtMost(fixedUsd, request.constraints.budgetUsd);
    handlerChecks.push(
      check("budget_covers_fixed_lines", covers, {
        value: request.constraints.budgetUsd,
        limit: fixedUsd,
        detail: covers
          ? `budget covers the fixed per-master cost of ${fixedUsd} USD`
          : `budget ${request.constraints.budgetUsd} USD is below the fixed per-master cost of ${fixedUsd} USD, which is part of the minimum`,
      }),
    );
    const hasMust = request.visualRequests.some((item) => item.strength === "must");
    if (hasMust) {
      const covered = request.visualRequests
        .filter((item) => item.strength === "must")
        .every((item) => input.classifications.some((known) => known.beatId === item.beatId && known.want === item.want));
      const pass = input.classifierProblem === undefined && covered;
      handlerChecks.push(
        check("requests_classified", pass, {
          detail: pass ? "every must request was classified" : (input.classifierProblem ?? "a must request has no classification"),
        }),
      );
    }
    const wordsPerMinute = input.kits.persona?.wordsPerMinute ?? input.kits.voice?.wordsPerMinute;
    if (wordsPerMinute === undefined) {
      const problem = `voice ${request.page.voiceId} has no words per minute, because neither its persona nor its voice kit did load; speech length cannot be estimated`;
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

/**
 * The pre-flight hold's reservation id. It is derived from the request and the job's attempt (the orchestrator's attempt, which
 * a resume advances). A retry of the same job gets the same id, so reserveFixed returns the hold it already made; a resume after
 * a budget pause gets a new id, because a paused hold is never revived (budget/STATUS.md decision 4).
 */
export function preflightReservationId(requestId: string, attempt: string): string {
  const digest = createHash("sha256").update(`intake_hold|${requestId}|${attempt}`).digest();
  const time = digest.readUIntBE(0, 6);
  const random = BigInt(`0x${digest.subarray(6, 16).toString("hex")}`);
  return `res_${encodeUlid(time, random)}`;
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError("invalid_input", `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`, { stage: ctx.stage });
}

/** The job's infrastructure attempt (Bible 5.1), from 1. An unreadable attempt is the first. */
function attemptNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** A gate with the checks that need no classifier, plus the reason the hold was not made. Pauses the request, never rejects it. */
function pausedOutcome(ctx: StageContext, probe: IntakeDecision, reason: string): StageRunResult {
  const kept = probe.gate.checks.filter((item) => !CLASSIFIER_RULES.has(item.rule));
  const gate = gateResult("request", ctx.requestId, [...kept, check("reservation_held", false, { detail: `nothing is held: ${reason}` })]);
  return { kind: "done", output: { stage: "intake", subjectId: ctx.subjectId, artifacts: {}, gate, budgetReservationId: null, budgetPause: reason } };
}

/** A refusal: the gate names why, nothing is held or spent, and the request is rejected. */
function rejectedOutcome(ctx: StageContext, gate: GateResult): StageRunResult {
  return { kind: "done", output: { stage: "intake", subjectId: ctx.subjectId, artifacts: {}, gate, budgetReservationId: null, budgetPause: null } };
}

/**
 * The intake stage. Pass the ports the worker wires; see IntakePorts for what an absent port means. Order: the request's own
 * checks (no money), then the pre-flight hold, then the classifier on that hold, then the final gate. A final failure releases
 * the hold.
 */
export function createIntakeHandler(ports: IntakePorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const stored = await readInputOfType(ctx, "production_request");
      const parsed = productionRequestSchema.safeParse(stored.envelope.body);
      if (!parsed.success) {
        throw new EngineError("invalid_input", `the production request artifact does not parse: ${parsed.error.message}`, { stage: ctx.stage });
      }
      const request = parsed.data;
      const organizationId = ctx.organizationId;
      const scope: KitScope = { organizationId, request };
      const kits = await ports.loadKits(scope);
      const videoDnaId = ports.lookupDna === undefined ? undefined : await ports.lookupDna(scope);
      const musts: VisualRequestRef[] = visualRequestsOf(request).filter((item) => item.strength === "must");

      // 1. The request's own checks, before any money. A failure here rejects the request and holds nothing.
      const probe = decideIntake({ request, kits, videoDnaId, classifications: [] });
      if (!probe.gate.checks.every((item) => item.pass || CLASSIFIER_RULES.has(item.rule))) {
        return rejectedOutcome(ctx, probe.gate);
      }
      if (musts.length > 0 && ports.roleDeps === undefined) {
        const gate = decideIntake({
          request,
          kits,
          videoDnaId,
          classifications: [],
          classifierProblem: "the request classifier is not connected, so a must request cannot be classified (Bible 7.3)",
        }).gate;
        return rejectedOutcome(ctx, gate);
      }

      // 2. The pre-flight hold (budget/preflight.ts). The workspace month must be known and usable first.
      const now = new Date().toISOString();
      const month: WorkspaceMonthBudget =
        ports.workspaceBudget === undefined
          ? { status: "not_connected", reason: "the workspace monthly budget is not connected: no source sets it" }
          : await ports.workspaceBudget.monthBudget({ organizationId, requestId: ctx.requestId, now });
      if (month.status !== "known") return pausedOutcome(ctx, probe, month.reason);
      if (!Number.isFinite(month.usd) || month.usd < 0) {
        return pausedOutcome(ctx, probe, `the workspace monthly budget source returned ${String(month.usd)}, which is not a usable amount`);
      }
      const reservationId = preflightReservationId(ctx.requestId, ctx.payload.attempt);
      const held = await withWorkspaceLedger(ctx.sql, organizationId, (store) =>
        reserveFixed(store, {
          requestId: ctx.requestId,
          workspaceId: organizationId,
          mode: budgets.productionMode,
          requestBudgetUsd: request.constraints.budgetUsd,
          workspaceMonthBudgetUsd: month.usd,
          now,
          reservationId,
        }),
      );
      if (held.reservation.state !== "reserved") {
        return pausedOutcome(ctx, probe, held.reservation.pausedReason ?? `the pre-flight hold is ${held.reservation.state}`);
      }

      // 3. The classifier, on the hold (7.3). Only the must requests are classified here.
      let classifications: VisualClassification[] = [];
      let classifierProblem: string | undefined;
      if (musts.length > 0 && ports.roleDeps !== undefined) {
        const outcome = await classifyVisualRequests(ports.roleDeps({ organizationId, requestId: ctx.requestId, reservationId }), {
          requestId: ctx.requestId,
          workspaceId: organizationId,
          reservationId,
          attempt: attemptNumber(ctx.payload.attempt),
          signal: ctx.signal,
          requests: musts,
        });
        if (outcome.status === "classified") classifications = outcome.classifications;
        else classifierProblem = outcome.reason;
      }

      // 4. The final gate. A pass keeps the hold; a failure releases it and rejects the request.
      const final = decideIntake({ request, kits, videoDnaId, classifications, ...(classifierProblem === undefined ? {} : { classifierProblem }) });
      if (final.gate.pass && final.validated !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "validated_request",
          body: final.validated,
          parentIds: [stored.envelope.artifactId],
          createdAt: now,
        });
        return {
          kind: "done",
          output: {
            stage: "intake",
            subjectId: ctx.subjectId,
            artifacts: { validated: written.artifactId },
            gate: final.gate,
            budgetReservationId: reservationId,
            budgetPause: null,
          },
        };
      }
      await withWorkspaceLedger(ctx.sql, organizationId, (store) => releaseReservation(store, reservationId));
      return rejectedOutcome(ctx, final.gate);
    },
  };
}
