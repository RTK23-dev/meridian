// The orchestrator's model choice for one request (Bible 10.5 steps 1 to 3, contracts v7 and v8). It runs once, after the plan is built
// and has passed its gate (jobs/handlers/plan.ts), and makes ONE model_chooser call for the whole request:
//
//   1. Calls. Every paid call the plan makes in a production model class: a generate shot is one call, named "shot" (the lead's
//      decision for contract v8); each call of a chain is named by its output.
//   2. Candidates. One catalog read (gateway/catalog.ts). For each call, the entries that fit its need (gateway/catalog-fit.ts), ranked by
//      config/model-preferences.ts (empty: catalog order) and capped at MODEL_CHOOSER_MAX_CANDIDATES.
//   3. Choice. The calls with at least one candidate go to model_chooser through runRole (budgeted, journaled, on the ledger). Its answer is
//      untrusted: resolveModelChoice (assets/model-choice.ts) accepts an id only when it is one of that call's candidates, and otherwise
//      (or when the role failed, was refused, or left the call out) takes the first eligible route-table target, source "fallback". A call
//      with no candidate, or with no eligible fallback, gets no choice and keeps the route table.
//   4. Record. Every call gets a Decision (in the plan's decisions, naming the shot and call), and every call with a choice is an entry of
//      the request's model_choices artifact, which produce_shot reads to put modelChoice on the call's asset spec.
//
// A catalog that cannot be read makes no role call and no artifact: every call keeps the route table, and one Decision says why.

import { EngineError } from "../contracts/errors.ts";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import type { ModelChoices } from "../contracts/model-choices.ts";
import type { Decision, ModelClass, ScenePlan, VisualType } from "../contracts/plan.ts";
import { PREFERENCE_MODEL_CLASSES } from "../config/model-preferences.ts";
import type { CatalogRead, ModelCatalogSource } from "../gateway/catalog.ts";
import { eligibleCandidates, rankCandidates, rejectionOf } from "../gateway/catalog-fit.ts";
import { runRole, type RoleDeps } from "../claude/client.ts";
import { MODEL_CHOOSER_MAX_CALLS, MODEL_CHOOSER_MAX_CANDIDATES, modelChooser, type ChooserCall, type ModelChooserAnswer } from "../claude/roles/model_chooser.ts";
import { catalogCallUsd, fallbackModelsFor, needFor, resolveModelChoice, type DirectorPick } from "../assets/model-choice.ts";
import { callPriceKey, GENERATE_CALL_OUTPUT, type ChosenCallPrice } from "../budget/estimate.ts";

/** The output name of a plain generate shot's one call (lead decision, contract v8). The budget estimate keys calls by it too. */
export const SINGLE_CALL_OUTPUT = GENERATE_CALL_OUTPUT;

/** One paid call of the plan, before its asset spec exists. */
export type PlannedCall = {
  shotId: string;
  output: string;
  visualType: VisualType;
  modelClass: ModelClass;
  durationMs: number;
  firstFrame: boolean;
  lastFrame: boolean;
  refCount: number;
};

const PRODUCTION: ReadonlySet<string> = new Set(PREFERENCE_MODEL_CLASSES);

/** The plan's paid calls in a production model class, in shot order and chain order. Pure. */
export function plannedCallsOf(plan: ScenePlan): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const shot of plan.shots) {
    const durationMs = shot.endMs - shot.startMs;
    const source = shot.source;
    if (source.kind === "generate") {
      calls.push({
        shotId: shot.shotId,
        output: SINGLE_CALL_OUTPUT,
        visualType: shot.visualType,
        modelClass: source.modelClass,
        durationMs,
        firstFrame: source.firstFrame !== undefined,
        lastFrame: source.lastFrame !== undefined,
        refCount: source.refs.length,
      });
    } else if (source.kind === "chain") {
      for (const call of source.calls) {
        calls.push({
          shotId: shot.shotId,
          output: call.output,
          visualType: shot.visualType,
          modelClass: call.modelClass,
          durationMs,
          firstFrame: call.firstFrame !== undefined,
          lastFrame: call.lastFrame !== undefined,
          refCount: call.refs.length,
        });
      }
    }
  }
  return calls.filter((call) => PRODUCTION.has(call.modelClass));
}

export type ModelChoiceRun = {
  /** The request's model_choices body, or null when the catalog could not be read (nothing to store). */
  choices: ModelChoices | null;
  /** One decision per call (or one for the whole request when the catalog could not be read). */
  decisions: Decision[];
  /** Whether a model_chooser call was asked for (false with no call that had a candidate). */
  roleCalled: boolean;
};

export type ChooseModelsInput = {
  deps: RoleDeps;
  catalog: ModelCatalogSource;
  requestId: string;
  workspaceId: string;
  reservationId: string;
  attempt: number;
  signal?: AbortSignal;
  plan: ScenePlan;
};

/** Why the role gave no usable answer, as the engine's own words. A bug (an internal error) is not a role failure and is thrown. */
function roleFailure(error: unknown): string {
  if (error instanceof EngineError && error.kind !== "internal") {
    return `the model_chooser call failed (${error.kind}): ${error.message.slice(0, 200)}`;
  }
  throw error;
}

/** The picks by call id: the first pick of each call. A repeated pick for a call is ignored (fail closed to the first). */
function picksById(answer: ModelChooserAnswer): Map<string, DirectorPick> {
  const picks = new Map<string, DirectorPick>();
  for (const pick of answer.picks) {
    if (!picks.has(pick.callId)) picks.set(pick.callId, { modelId: pick.modelId, reason: pick.reason });
  }
  return picks;
}

/** Runs the request's model choice. See the file header. */
export async function chooseModels(input: ChooseModelsInput): Promise<ModelChoiceRun> {
  const at = input.deps.now();
  const calls = plannedCallsOf(input.plan);
  if (calls.length === 0) {
    return { choices: null, decisions: [], roleCalled: false };
  }

  const read = await input.catalog.read(input.workspaceId);
  if (read.status === "not_connected") {
    return {
      choices: null,
      roleCalled: false,
      decisions: [
        {
          at,
          chose: "route table for every call",
          alternatives: [],
          reason: `no model is chosen from the catalog: ${read.reason}`,
          by: "scorer",
        },
      ],
    };
  }
  const catalog = read.catalog;
  const failedNote = catalog.failed.length > 0 ? `; listings not read: ${catalog.failed.map((failure) => failure.source).join(", ")}` : "";

  // 2. The candidates of each call.
  const eligibleByCall = calls.map((call) => {
    const fit = eligibleCandidates(needFor(call), catalog.entries);
    return rankCandidates(call.modelClass, fit.eligible).slice(0, MODEL_CHOOSER_MAX_CANDIDATES);
  });

  // 3. One role call for the calls that have candidates.
  const asked: Array<{ index: number; call: ChooserCall }> = [];
  calls.forEach((call, index) => {
    const candidates: ModelCatalogEntry[] = eligibleByCall[index] ?? [];
    if (candidates.length === 0 || asked.length >= MODEL_CHOOSER_MAX_CALLS) return;
    asked.push({
      index,
      call: {
        callId: `c${asked.length + 1}`,
        shotId: call.shotId,
        output: call.output,
        visualType: call.visualType,
        modelClass: call.modelClass,
        durationSeconds: call.durationMs / 1000,
        firstFrame: call.firstFrame,
        lastFrame: call.lastFrame,
        refCount: call.refCount,
        candidates: candidates.map((entry) => ({ id: entry.id, capabilities: entry.capabilities, price: entry.price })),
      },
    });
  });

  let picks = new Map<string, DirectorPick>();
  let failure: string | null = null;
  if (asked.length > 0) {
    try {
      const outcome = await runRole(input.deps, modelChooser, {
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        reservationId: input.reservationId,
        attempt: input.attempt,
        signal: input.signal,
        input: { calls: asked.map((item) => item.call) },
      });
      if (outcome.status === "done") picks = picksById(outcome.value);
      else if (outcome.status === "refused") failure = `the model_chooser call was refused: ${outcome.reason}`;
      else failure = "an earlier model_chooser call for this input has no stored answer, so it is not asked again";
    } catch (error) {
      failure = roleFailure(error);
    }
  }

  // 4. Resolve every call, and record it.
  const callIdOf = new Map(asked.map((item) => [item.index, item.call.callId]));
  const entries: ModelChoices["choices"] = [];
  const decisions: Decision[] = [];
  calls.forEach((call, index) => {
    const eligible = eligibleByCall[index] ?? [];
    const callId = callIdOf.get(index);
    const pick = callId === undefined ? null : (picks.get(callId) ?? null);
    const why =
      eligible.length === 0
        ? "no catalog candidate fits this call"
        : callId === undefined
          ? `the request has more than ${MODEL_CHOOSER_MAX_CALLS} calls, so this one was not sent to model_chooser`
          : (failure ?? "model_chooser gave no pick for this call");
    const resolved = resolveModelChoice({
      modelClass: call.modelClass,
      eligible,
      pick,
      failure: pick === null ? why : null,
      fallbackModels: fallbackModelsFor(input.deps.gateway, call.modelClass),
      catalogReadAt: catalog.readAt,
      at,
    });
    decisions.push({ ...resolved.decision, reason: `${call.shotId} ${call.output}: ${resolved.decision.reason}${failedNote}` });
    if (resolved.modelChoice !== null) {
      entries.push({ shotId: call.shotId, output: call.output, modelClass: call.modelClass, modelChoice: resolved.modelChoice });
    }
  });

  return {
    choices: { schema: "meridian.model_choices/v1", requestId: input.requestId, catalogReadAt: catalog.readAt, choices: entries },
    decisions,
    roleCalled: asked.length > 0,
  };
}

/**
 * The catalog price of each chosen call, for estimate_reserve (Bible 10.5 step 5, 14.1 step 1). It applies the router's own check: the
 * chosen model must still be in the catalog for the call's class and still fit the call, and its per-call estimate is the router's
 * (catalogCallUsd). A choice that fails the check is left out with a note, so that call is priced from the price table, as the router
 * then routes it by the route table. With the catalog not connected, every call is priced from the price table. Pure.
 */
export function chosenCallPricesOf(input: { plan: ScenePlan; choices: ModelChoices; catalog: CatalogRead }): {
  prices: Map<string, ChosenCallPrice>;
  notes: string[];
} {
  const prices = new Map<string, ChosenCallPrice>();
  const notes: string[] = [];
  if (input.choices.choices.length === 0) return { prices, notes };
  if (input.catalog.status === "not_connected") {
    notes.push(`the chosen models are priced from the price table: ${input.catalog.reason}`);
    return { prices, notes };
  }
  const entries = input.catalog.catalog.entries;
  const calls = new Map(plannedCallsOf(input.plan).map((call) => [callPriceKey(call.shotId, call.output), call]));
  for (const choice of input.choices.choices) {
    const key = callPriceKey(choice.shotId, choice.output);
    const call = calls.get(key);
    const label = `${choice.shotId} ${choice.output}`;
    if (call === undefined || call.modelClass !== choice.modelClass) {
      notes.push(`${label}: the choice names no call of this plan, so it is not used`);
      continue;
    }
    const entry = entries.find((candidate) => candidate.id === choice.modelChoice.modelId && candidate.modelClasses.includes(call.modelClass));
    if (entry === undefined) {
      notes.push(`${label}: ${choice.modelChoice.modelId} is no longer in the catalog, so the call is priced from the price table`);
      continue;
    }
    const gap = rejectionOf(needFor(call), entry);
    if (gap !== null) {
      notes.push(`${label}: ${entry.id} no longer fits the call (${gap.reason}), so the call is priced from the price table`);
      continue;
    }
    prices.set(key, { provider: `openrouter:${entry.id}`, perCallUsd: catalogCallUsd(entry, call.durationMs) });
  }
  return { prices, notes };
}
