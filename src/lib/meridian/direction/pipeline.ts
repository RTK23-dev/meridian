// The direction pipeline (framework 12.1, steps C to G, and 12.4): from a brief to one directed script, with the record of how it was
// chosen. Diverge (the concept lab, on a creative deck, from more than one model slot), filter (obvious, repeated, duplicate), converge
// (a pairwise viewer panel, every pair shown in both orders, ranked by Bradley-Terry), keep finalists apart, script each finalist, check
// it (slop, attention, facts, hook history), let the swipe tester walk it, revise at most twice, and let the panel choose between the
// finished scripts.
//
// Nothing here calls a provider. The model port is passed in: the live port (live.server.ts) goes through Meridian's generation path,
// which holds and settles the workspace's budget per call; the tests pass a recorded one. Every call counts against `maxCalls`, a hard
// limit. A run is "ready" only when a script passed every check and both floors, the swipe tester would ship it, and every ranking that
// chose it was reliable. Anything less is "needs_person" with the reasons, or "failed" when nothing usable was made: never a fake success.

import { untrustedBlock } from "../../../engine/prompts/untrusted.ts";
import { evidencedScores, parseAnswer, swipeTestAnswerSchema, viewerPanelAnswerSchema, type SwipeTestAnswer, type ViewerPanelAnswer } from "./answers.ts";
import { DIRECTION_CODEX_VERSION, formatArchetype, leanInScore, type NicheFamily, type VideoJob } from "./codex.ts";
import {
  cardsForCall,
  conceptLabAnswerSchema,
  creativeDeck,
  filterConcepts,
  poolConcepts,
  selectDiverse,
  type Concept,
  type ConceptDrop,
  type ConceptLabAnswer,
  type DeckCard,
} from "./concepts.ts";
import { PIPELINE_DIRECTIVE_CHARS, directionDirectives } from "./directives.ts";
import { CURRENT_DIRECTION_PROMPTS, directionPrompt, type DirectionStep } from "./prompts.ts";
import { directionReport, revisionNotes, type DirectionReport } from "./report.ts";
import { directedScriptV2Schema, type DirectedScript } from "./script.ts";
import {
  bradleyTerry,
  pairSchedule,
  ranked,
  reliability,
  resolvePair,
  type Pair,
  type PairResult,
  type Reliability,
  type Showing,
} from "./tournament.ts";
import type { z } from "zod";

/** What a direction run is for. Everything but the settings is untrusted material: it reaches a model only inside a data block. */
export type DirectionRequest = {
  brief: { text: string; sources: { label: string; text: string }[] };
  brand: { name: string; claims: string[]; forbidden: string[]; tone?: string };
  audience?: string;
  niche?: NicheFamily;
  language: string;
  maxDurationMs: number;
  /** The voice's pace, when known. */
  wordsPerMinute?: number;
  /** The brand's recent hooks (content-factory hook history). An empty list when it has none. */
  recentHooks: string[];
  /** Dated trends from Meridian's discovery data. The models may use these and no others. */
  trends: { text: string; observedAt: string }[];
  /** The video's one job (codex 2): reach, follow or convert. Reach when not given. */
  job?: VideoJob;
};

/**
 * How a run is shaped. Slots name model seats, not models: the port maps each slot to the model the workspace chose for it. Use at least
 * two writer slots on different model families, and a judge slot on a family that is not a writer's (framework 3.3).
 */
export type DirectionSettings = {
  writers: string[];
  judge: string;
  director: string;
  conceptCalls: number;
  conceptsPerCall: number;
  /** Each concept meets about twice this many others in the tournament. */
  opponents: number;
  finalists: number;
  maxRevisions: number;
  /** A hard limit on model calls, retries included. */
  maxCalls: number;
  /** The seed of the deck and the pair order, so a run can be replayed. */
  seed: string;
  /**
   * Who picks among the finished scripts. "panel" (the default) runs a last pairwise panel and returns its pick; "person" returns every
   * finished script as an option, best-ranked concept first, and lets a person choose (the Scripts panel, an agent).
   */
  choose?: "panel" | "person";
};

export const DEFAULT_DIRECTION_SETTINGS = {
  conceptCalls: 3,
  conceptsPerCall: 6,
  opponents: 2,
  finalists: 2,
  maxRevisions: 2,
  maxCalls: 40,
} as const;

/** Pairs judged in one panel call. */
export const PAIRS_PER_CALL = 6;

export type ModelCall = {
  step: DirectionStep;
  slot: string;
  promptId: string;
  promptHash: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
};
/**
 * A model call's reply. A failure says whether it may have been billed: "no" when nothing was sent or the provider refused it before any
 * work, "unknown" when it may have been (a timeout, an unreadable reply). An unknown bill makes the run's total unknown.
 */
export type ModelReply = { ok: true; content: string; model: string; costUsd: number | null } | { ok: false; error: string; billed: "no" | "unknown" };
export type DirectionPort = { complete(call: ModelCall): Promise<ModelReply> };

export type CallRecord = { step: DirectionStep; slot: string; promptId: string; attempt: number; ok: boolean; model?: string; costUsd?: number | null; error?: string };

export type ScriptAttempt = { script: DirectedScript; report: DirectionReport; swipe: SwipeTestAnswer | null; leanIn: number | null };
export type FinalistRecord = { conceptId: string; attempts: ScriptAttempt[]; error?: string };

/** One finished script a person can choose: its concept, its drafts (the last is the script), and whether it ships. */
export type ScriptOption = {
  conceptId: string;
  concept: Concept;
  attempts: ScriptAttempt[];
  /** The last draft passed every check and the swipe test would ship it with no leak. */
  ships: boolean;
  /** 1 for the panel's pick: the final panel's order, or, when a person chooses, the concept ranking's. */
  rank: number;
  error?: string;
};

/** The swipe test would ship the attempt, and nothing blocks it. */
export function attemptShips(attempt: ScriptAttempt): boolean {
  return !attempt.report.blocked && attempt.swipe?.verdict === "ship" && attempt.swipe.blocker === "none";
}

export type DirectionRun = {
  status: "ready" | "needs_person" | "failed";
  /** Why the run has its status. Empty only when it is ready. */
  reasons: string[];
  /** Things a person should know that did not change the status. */
  notes: string[];
  codexVersion: string;
  prompts: Record<DirectionStep, string>;
  deck: DeckCard[];
  obvious: string[];
  concepts: Concept[];
  dropped: ConceptDrop[];
  ranking: { id: string; rating: number }[];
  conceptReliability: Reliability | null;
  finalists: FinalistRecord[];
  finalReliability: Reliability | null;
  chosen: { conceptId: string; script: DirectedScript; report: DirectionReport } | null;
  /** Every finalist with at least one draft, best first. */
  options: ScriptOption[];
  calls: CallRecord[];
  /** The sum of the costs the provider reported. Null when any call's cost is unknown: none reported, or a failure that may have been billed. */
  costUsd: number | null;
};

const MAX_TOKENS: Record<DirectionStep, number> = { concept_lab: 3200, viewer_panel: 1400, script_director: 2600, swipe_test: 2400 };
const TEMPERATURE: Record<DirectionStep, number> = { concept_lab: 1, viewer_panel: 0, script_director: 0.7, swipe_test: 0 };

class CallBudget extends Error {}

/** Run direction for one request. Never throws for a model failure: failures are recorded and shape the status. */
export async function runDirection(request: DirectionRequest, port: DirectionPort, settings: DirectionSettings): Promise<DirectionRun> {
  const calls: CallRecord[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];
  const run: DirectionRun = {
    status: "failed",
    reasons,
    notes,
    codexVersion: DIRECTION_CODEX_VERSION,
    prompts: {
      concept_lab: directionPrompt("concept_lab").id,
      viewer_panel: directionPrompt("viewer_panel").id,
      script_director: directionPrompt("script_director").id,
      swipe_test: directionPrompt("swipe_test").id,
    },
    deck: [],
    obvious: [],
    concepts: [],
    dropped: [],
    ranking: [],
    conceptReliability: null,
    finalists: [],
    finalReliability: null,
    chosen: null,
    options: [],
    calls,
    costUsd: null,
  };

  if (settings.writers.length === 0) {
    reasons.push("No writer slot was given, so no concept could be written.");
    return finish(run);
  }
  if (settings.writers.length < 2) notes.push("One writer slot only: the concepts come from one model, and models converge on the same ideas. Add a second family.");
  if (settings.writers.includes(settings.judge)) notes.push("The judge shares a slot with a writer: judges prefer their own model's text, so the ranking may lean to that writer.");

  const call = makeCaller(port, settings.maxCalls, calls);

  try {
    // C. Divergence: the concept lab on the deck, alternating writer slots.
    run.deck = creativeDeck({ count: settings.conceptCalls * settings.conceptsPerCall, seed: settings.seed, niche: request.niche });
    const answers: { family: string; call: number; answer: ConceptLabAnswer }[] = [];
    for (let index = 0; index < settings.conceptCalls; index += 1) {
      const slot = settings.writers[index % settings.writers.length]!;
      const cards = cardsForCall(run.deck, index, settings.conceptsPerCall);
      const answer = await call("concept_lab", slot, conceptLabUser(request, cards), conceptLabAnswerSchema);
      if (answer) answers.push({ family: slot, call: index, answer });
    }
    const pool = poolConcepts(answers);
    run.obvious = pool.obvious;

    // D. Filter: the obvious ideas, the brand's recent hooks, duplicates.
    const filtered = filterConcepts(pool.concepts, { obvious: pool.obvious, recentHooks: request.recentHooks });
    run.concepts = filtered.kept;
    run.dropped = filtered.dropped;
    if (filtered.kept.length < 2) {
      reasons.push(`Only ${filtered.kept.length} distinct concept${filtered.kept.length === 1 ? "" : "s"} survived the filters, from ${pool.concepts.length} written. A choice needs at least two.`);
      return finish(run);
    }

    // E. Converge: the viewer panel on pairs, both orders; Bradley-Terry; finalists kept apart.
    const byId = new Map(filtered.kept.map((concept) => [concept.id, concept]));
    const tournament = await panel(
      filtered.kept.map((concept) => concept.id),
      pairSchedule(
        filtered.kept.map((concept) => concept.id),
        settings.opponents,
        settings.seed,
      ),
      (id) => conceptItem(byId.get(id)!),
      request,
      settings,
      call,
    );
    run.conceptReliability = tournament.reliability;
    run.ranking = tournament.order.map(({ id, rating }) => ({ id, rating }));
    if (tournament.reliability.unreliable) {
      reasons.push(`The panel's concept ranking was not reliable: ${Math.round(tournament.reliability.consistency * 100)}% of pairs kept their winner when the order was swapped.`);
    }
    const finalists = selectDiverse(
      tournament.order.map(({ id, rating }) => ({ concept: byId.get(id)!, rating })),
      settings.finalists,
    );

    // F and G. Script each finalist; check it; the swipe test; revise.
    for (const concept of finalists) {
      const record: FinalistRecord = { conceptId: concept.id, attempts: [] };
      run.finalists.push(record);
      const outcome = await draftAndCheck({ request, concept, draft: null, rounds: settings.maxRevisions + 1, director: settings.director, judge: settings.judge, call, attempts: record.attempts });
      if (outcome.error) record.error = outcome.error;
    }
    run.options = optionsOf(run);

    // Final choice among the finished scripts.
    const finished = run.finalists
      .map((record) => ({ record, last: record.attempts.at(-1) }))
      .filter((entry): entry is { record: FinalistRecord; last: ScriptAttempt } => entry.last !== undefined && !entry.last.report.blocked);
    if (finished.length === 0) {
      reasons.push("No script passed the checks: every finalist still has a blocking finding.");
      return finish(run);
    }
    const shippable = finished.filter((entry) => attemptShips(entry.last));
    for (const entry of finished.filter((candidate) => !attemptShips(candidate.last))) {
      const line = `The swipe test would not ship the script of ${entry.record.conceptId} after ${entry.record.attempts.length} draft${entry.record.attempts.length === 1 ? "" : "s"}.`;
      (shippable.length === 0 ? reasons : notes).push(line);
    }
    const candidates = shippable.length > 0 ? shippable : finished;
    let winner = candidates[0]!;
    if (settings.choose === "person") {
      // A person chooses: every finished script is an option, in concept-ranking order; the first that ships is the suggestion.
      const first = run.options.find((option) => option.ships) ?? run.options.find((option) => !option.attempts.at(-1)!.report.blocked);
      if (first) winner = { record: run.finalists.find((record) => record.conceptId === first.conceptId)!, last: first.attempts.at(-1)! };
    } else if (candidates.length > 1) {
      const scripts = new Map(candidates.map((entry) => [entry.record.conceptId, entry.last.script]));
      const ids = candidates.map((entry) => entry.record.conceptId);
      const final = await panel(ids, pairSchedule(ids, ids.length, `${settings.seed}:final`), (id) => scriptItem(scripts.get(id)!), request, settings, call);
      run.finalReliability = final.reliability;
      const top = final.order[0];
      const runnerUp = final.order[1];
      if (final.reliability.unreliable || !top || (runnerUp && runnerUp.rating === top.rating)) {
        reasons.push("The panel did not reliably prefer one finished script. A person should choose between them.");
      }
      winner = candidates.find((entry) => entry.record.conceptId === top?.id) ?? winner;
      const finalRank = new Map(final.order.map((entry, index) => [entry.id, index]));
      run.options = [...run.options]
        .sort((a, b) => (finalRank.get(a.conceptId) ?? Number.MAX_SAFE_INTEGER) - (finalRank.get(b.conceptId) ?? Number.MAX_SAFE_INTEGER))
        .map((option, index) => ({ ...option, rank: index + 1 }));
    }
    run.chosen = { conceptId: winner.record.conceptId, script: winner.last.script, report: winner.last.report };
    run.status = reasons.length === 0 ? "ready" : "needs_person";
    return finish(run);
  } catch (error) {
    if (!(error instanceof CallBudget)) throw error;
    reasons.push(`The run reached its limit of ${settings.maxCalls} model calls before it finished.`);
    // The drafts already paid for stay options, so a person can still see and choose them.
    if (run.options.length === 0) run.options = optionsOf(run);
    run.status = run.finalists.some((record) => record.attempts.some((attempt) => !attempt.report.blocked)) ? "needs_person" : "failed";
    return finish(run, true);
  }
}

/** Every finalist with at least one draft, in concept-ranking order. */
function optionsOf(run: DirectionRun): ScriptOption[] {
  const byId = new Map(run.concepts.map((concept) => [concept.id, concept]));
  const rankOf = new Map(run.ranking.map((entry, index) => [entry.id, index]));
  return run.finalists
    .filter((record) => record.attempts.length > 0 && byId.has(record.conceptId))
    .sort((a, b) => (rankOf.get(a.conceptId) ?? 0) - (rankOf.get(b.conceptId) ?? 0))
    .map((record, index) => ({
      conceptId: record.conceptId,
      concept: byId.get(record.conceptId)!,
      attempts: record.attempts,
      ships: attemptShips(record.attempts.at(-1)!),
      rank: index + 1,
      ...(record.error ? { error: record.error } : {}),
    }));
}

function finish(run: DirectionRun, keepStatus = false): DirectionRun {
  if (!keepStatus && run.status !== "ready" && run.chosen === null) run.status = "failed";
  const costs = run.calls.map((record) => record.costUsd);
  run.costUsd = costs.some((cost) => cost === null || cost === undefined) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  return run;
}

type Caller = <T>(step: DirectionStep, slot: string, user: string, schema: z.ZodType<T>) => Promise<T | null>;

/** A model caller with one retry on a contract miss, recording every call, and a hard limit on the number of calls. */
function makeCaller(port: DirectionPort, maxCalls: number, calls: CallRecord[]): Caller {
  return async <T>(step: DirectionStep, slot: string, user: string, schema: z.ZodType<T>): Promise<T | null> => {
    const prompt = directionPrompt(step, CURRENT_DIRECTION_PROMPTS[step]);
    let message = user;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (calls.length >= maxCalls) throw new CallBudget();
      const reply = await port.complete({
        step,
        slot,
        promptId: prompt.id,
        promptHash: prompt.hash,
        system: prompt.text,
        user: message,
        temperature: TEMPERATURE[step],
        maxTokens: MAX_TOKENS[step],
      });
      if (!reply.ok) {
        calls.push({ step, slot, promptId: prompt.id, attempt, ok: false, error: reply.error, costUsd: reply.billed === "no" ? 0 : null });
        return null;
      }
      const parsed = parseAnswer(reply.content, schema);
      calls.push({ step, slot, promptId: prompt.id, attempt, ok: parsed.ok, model: reply.model, costUsd: reply.costUsd, ...(parsed.ok ? {} : { error: parsed.error }) });
      if (parsed.ok) return parsed.value;
      message = `${user}\n\nYour last answer was refused (${parsed.error}). Answer again with one JSON object that follows the output contract.`;
    }
    return null;
  };
}

/**
 * Script a concept (or revise a draft of it), check it, swipe-test it, and revise until it ships or the rounds run out. A person's note, when
 * given, goes with every revision. Each draft is added to `attempts` as soon as it is written, so a run stopped by its call limit keeps
 * every draft it paid for (one stopped before its swipe test has none).
 */
async function draftAndCheck(input: {
  request: DirectionRequest;
  concept: DirectorConcept;
  draft: ScriptAttempt | null;
  note?: string;
  rounds: number;
  director: string;
  judge: string;
  call: Caller;
  attempts: ScriptAttempt[];
}): Promise<{ error?: string }> {
  let draft = input.draft;
  for (let round = 0; round < input.rounds; round += 1) {
    const script: DirectedScript | null = await input.call("script_director", input.director, directorUser(input.request, input.concept, draft, input.note), directedScriptV2Schema);
    if (!script) return { error: draft ? "A revision was not returned; the last draft stands." : "The script director returned no usable script." };
    const attempt: ScriptAttempt = { script, report: reportFor(input.request, script), swipe: null, leanIn: null };
    input.attempts.push(attempt);
    draft = attempt;
    const swipe: SwipeTestAnswer | null = await input.call("swipe_test", input.judge, swipeUser(input.request, script, attempt.report), swipeTestAnswerSchema);
    if (!swipe) return { error: "The swipe test returned no usable answer, so the draft could not be judged or revised." };
    attempt.swipe = swipe;
    attempt.leanIn = leanInScore(evidencedScores(swipe));
    if (attemptShips(attempt)) break;
  }
  return {};
}

export type RevisionRun = {
  status: "ready" | "needs_person" | "failed";
  reasons: string[];
  attempts: ScriptAttempt[];
  prompts: Pick<Record<DirectionStep, string>, "script_director" | "swipe_test">;
  codexVersion: string;
  calls: CallRecord[];
  costUsd: number | null;
};

/**
 * Regenerate one script by revising it (the Scripts panel's Regenerate, an agent's revise): the director gets the draft, its findings, the
 * swipe test's critique and the person's note, then each new draft is checked and swipe-tested, at most `rounds` times. "ready" when the
 * last draft ships; "needs_person" when it passes the checks but the swipe test would not ship it; "failed" when nothing usable came back
 * or a check still blocks.
 */
export async function reviseDirectedScript(
  input: { request: DirectionRequest; concept: Concept; draft: ScriptAttempt; note?: string },
  port: DirectionPort,
  settings: { director: string; judge: string; maxCalls: number; rounds?: number },
): Promise<RevisionRun> {
  const calls: CallRecord[] = [];
  const reasons: string[] = [];
  const out: RevisionRun = {
    status: "failed",
    reasons,
    attempts: [],
    prompts: { script_director: directionPrompt("script_director").id, swipe_test: directionPrompt("swipe_test").id },
    codexVersion: DIRECTION_CODEX_VERSION,
    calls,
    costUsd: null,
  };
  try {
    const outcome = await draftAndCheck({
      request: input.request,
      concept: input.concept,
      draft: input.draft,
      note: input.note?.trim() || undefined,
      rounds: Math.max(1, settings.rounds ?? 2),
      director: settings.director,
      judge: settings.judge,
      call: makeCaller(port, settings.maxCalls, calls),
      attempts: out.attempts,
    });
    if (outcome.error) reasons.push(outcome.error);
  } catch (error) {
    if (!(error instanceof CallBudget)) throw error;
    reasons.push(`The revision reached its limit of ${settings.maxCalls} model calls before it finished.`);
  }
  const last = out.attempts.at(-1);
  if (!last) {
    if (reasons.length === 0) reasons.push("No revision came back.");
  } else if (last.report.blocked) {
    reasons.push("The revision still has a blocking finding.");
  } else if (attemptShips(last)) {
    out.status = "ready";
  } else {
    out.status = "needs_person";
    reasons.push(last.swipe ? "The revision passes the checks, but the swipe test would not ship it yet." : "The revision passes the checks, but the swipe test did not judge it.");
  }
  const costs = calls.map((record) => record.costUsd);
  out.costUsd = costs.some((cost) => cost === null || cost === undefined) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  return out;
}

/** One tournament: every pair judged in both orders, in calls of PAIRS_PER_CALL pairs; a missing verdict is a tie, never a win. */
async function panel(
  ids: string[],
  pairs: Pair[],
  itemOf: (id: string) => unknown,
  request: DirectionRequest,
  settings: DirectionSettings,
  call: Caller,
): Promise<{ order: { id: string; rating: number }[]; reliability: Reliability }> {
  const showings: Showing[] = [];
  const results: PairResult[] = [];
  for (let start = 0; start < pairs.length; start += PAIRS_PER_CALL) {
    const chunk = pairs.slice(start, start + PAIRS_PER_CALL);
    const rounds: Showing[][] = [];
    for (const swapped of [false, true]) {
      const shown = chunk.map((pair) => (swapped ? { first: pair.b, second: pair.a } : { first: pair.a, second: pair.b }));
      const answer = await call(
        "viewer_panel",
        settings.judge,
        panelUser(request, shown.map((entry, index) => ({ pair: index, first: itemOf(entry.first), second: itemOf(entry.second) }))),
        viewerPanelAnswerSchema,
      );
      const verdicts = new Map<number, ViewerPanelAnswer["verdicts"][number]>();
      for (const verdict of answer?.verdicts ?? []) if (!verdicts.has(verdict.pair)) verdicts.set(verdict.pair, verdict);
      rounds.push(chunk.map((pair, index) => ({ pair, first: shown[index]!.first, second: shown[index]!.second, verdict: verdicts.get(index)?.choice ?? "tie" })));
    }
    chunk.forEach((_, index) => {
      const forward = rounds[0]![index]!;
      const swapped = rounds[1]![index]!;
      showings.push(forward, swapped);
      results.push(resolvePair(forward, swapped));
    });
  }
  const strengths = bradleyTerry(ids, results);
  return { order: ranked(ids, strengths), reliability: reliability(showings, results) };
}

/** Everything the brief gives, for the number check: its text, its sources and the approved claims. */
function factsOf(request: DirectionRequest): string {
  return [request.brief.text, ...request.brief.sources.map((source) => source.text), ...request.brand.claims].join("\n");
}

/** The report of a script for a request: the checks a run applies to every draft (the agent tools check a script the same way). */
export function reportFor(request: DirectionRequest, script: DirectedScript): DirectionReport {
  return directionReport(script, {
    wordsPerMinute: request.wordsPerMinute,
    recentHooks: request.recentHooks,
    maxDurationMs: request.maxDurationMs,
    forbidden: request.brand.forbidden,
    facts: factsOf(request),
  });
}

/** A concept as the director reads it: the agent tools pass one an agent wrote, which has no id or source yet. */
export type DirectorConcept = Omit<Concept, "id" | "source"> & Partial<Pick<Concept, "id" | "source">>;

/**
 * The user message a run sends one step, so an agent acting as that role (agent mode, scripts/direction.ts) is given exactly what a
 * model is given: the same direction block and the same data blocks.
 */
export function directionUserMessage(
  input:
    | { step: "concept_lab"; request: DirectionRequest; cards: DeckCard[] }
    | { step: "viewer_panel"; request: DirectionRequest; pairs: { pair: number; first: unknown; second: unknown }[] }
    | { step: "script_director"; request: DirectionRequest; concept: DirectorConcept; draft?: ScriptAttempt | null; note?: string }
    | { step: "swipe_test"; request: DirectionRequest; script: DirectedScript },
): string {
  switch (input.step) {
    case "concept_lab":
      return conceptLabUser(input.request, input.cards);
    case "viewer_panel":
      return panelUser(input.request, input.pairs);
    case "script_director":
      return directorUser(input.request, input.concept, input.draft ?? null, input.note?.trim() || undefined);
    case "swipe_test":
      return swipeUser(input.request, input.script, reportFor(input.request, input.script));
  }
}

function conceptItem(concept: Concept): unknown {
  return {
    firstTwoSeconds: { picture: concept.hook.picture, onScreen: concept.hook.text, voice: concept.hook.voice },
    promise: concept.promise,
    payoff: concept.payoff,
    format: formatArchetype(concept.format).name,
  };
}

function scriptItem(script: DirectedScript): unknown {
  return { beats: script.beats.map((beat) => ({ voice: beat.voice, onScreen: beat.onScreenText ?? "", picture: beat.picture ?? "" })) };
}

function directionBlock(text: string): string {
  return `Meridian's direction (trusted, ours):\n${text}`;
}

function jobOf(request: DirectionRequest): VideoJob {
  return request.job ?? "reach";
}

function conceptLabUser(request: DirectionRequest, cards: DeckCard[]): string {
  const options = { niche: request.niche, job: jobOf(request) };
  return [
    directionBlock(`${directionDirectives("script", options, PIPELINE_DIRECTIVE_CHARS)}\n\n${directionDirectives("agent", options, PIPELINE_DIRECTIVE_CHARS)}`),
    untrustedBlock("brief", request.brief),
    untrustedBlock("brand", request.brand),
    untrustedBlock("audience", { notes: request.audience ?? "" }),
    untrustedBlock("trends", request.trends),
    untrustedBlock("cards", cards),
    untrustedBlock("limits", { maxDurationMs: request.maxDurationMs, language: request.language, job: jobOf(request) }),
  ].join("\n\n");
}

function panelUser(request: DirectionRequest, pairs: { pair: number; first: unknown; second: unknown }[]): string {
  return [
    `The video's job is ${jobOf(request)}. Audience notes are in the first block. Judge each pair as these viewers.`,
    untrustedBlock("audience", { notes: request.audience ?? "" }),
    untrustedBlock("pairs", pairs),
  ].join("\n\n");
}

function directorUser(request: DirectionRequest, concept: DirectorConcept, draft: ScriptAttempt | null, note?: string): string {
  const options = { format: concept.format, hookFamily: concept.hookFamily, niche: request.niche, job: jobOf(request) };
  const blocks = [
    directionBlock(
      [
        directionDirectives("script", options, PIPELINE_DIRECTIVE_CHARS),
        directionDirectives("visual", options, PIPELINE_DIRECTIVE_CHARS),
        directionDirectives("voice", options, PIPELINE_DIRECTIVE_CHARS),
      ].join("\n\n"),
    ),
    untrustedBlock("concept", conceptItemForDirector(concept)),
    untrustedBlock("brief", request.brief),
    untrustedBlock("brand", request.brand),
    untrustedBlock("limits", { maxDurationMs: request.maxDurationMs, wordsPerMinute: request.wordsPerMinute ?? null, language: request.language, job: jobOf(request) }),
  ];
  if (draft) {
    blocks.push(
      untrustedBlock("draft", draft.script),
      untrustedBlock("findings", revisionNotes(draft.report)),
      untrustedBlock("critique", {
        blocker: draft.swipe?.blocker ?? "none",
        risky: (draft.swipe?.windows ?? []).filter((window) => window.risk === "high").map((window) => ({ beatId: window.beatId, fromMs: window.fromMs, reason: window.reason })),
        fixes: draft.swipe?.fixes ?? [],
      }),
    );
    if (note) blocks.push(untrustedBlock("person", { notes: note }));
  }
  return blocks.join("\n\n");
}

function conceptItemForDirector(concept: DirectorConcept): unknown {
  const { id: _id, source: _source, probability: _probability, ...seed } = concept;
  return seed;
}

function swipeUser(request: DirectionRequest, script: DirectedScript, report: DirectionReport): string {
  return [
    directionBlock(directionDirectives("critic", {}, PIPELINE_DIRECTIVE_CHARS)),
    untrustedBlock("audience", { notes: request.audience ?? "" }),
    untrustedBlock("script", script),
    untrustedBlock(
      "timeline",
      report.timeline.map((beat) => ({ beatId: beat.beatId, startMs: beat.startMs, endMs: beat.endMs })),
    ),
  ].join("\n\n");
}
