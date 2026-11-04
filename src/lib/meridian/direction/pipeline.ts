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
import { DIRECTION_CODEX_VERSION, formatArchetype, leanInScore, type NicheFamily } from "./codex.ts";
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
import { directionDirectives } from "./directives.ts";
import { CURRENT_DIRECTION_PROMPTS, directionPrompt, type DirectionStep } from "./prompts.ts";
import { directionReport, revisionNotes, type DirectionReport } from "./report.ts";
import { directedScriptSchema, type DirectedScript } from "./script.ts";
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
    calls,
    costUsd: null,
  };

  if (settings.writers.length === 0) {
    reasons.push("No writer slot was given, so no concept could be written.");
    return finish(run);
  }
  if (settings.writers.length < 2) notes.push("One writer slot only: the concepts come from one model, and models converge on the same ideas. Add a second family.");
  if (settings.writers.includes(settings.judge)) notes.push("The judge shares a slot with a writer: judges prefer their own model's text, so the ranking may lean to that writer.");

  const call = async <T>(step: DirectionStep, slot: string, user: string, schema: z.ZodType<T>): Promise<T | null> => {
    const prompt = directionPrompt(step, CURRENT_DIRECTION_PROMPTS[step]);
    let message = user;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (calls.length >= settings.maxCalls) throw new CallBudget();
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
      let draft: ScriptAttempt | null = null;
      for (let round = 0; round <= settings.maxRevisions; round += 1) {
        const script: DirectedScript | null = await call("script_director", settings.director, directorUser(request, concept, draft), directedScriptSchema);
        if (!script) {
          record.error = draft ? "A revision was not returned; the last draft stands." : "The script director returned no usable script.";
          break;
        }
        const report = directionReport(script, {
          wordsPerMinute: request.wordsPerMinute,
          recentHooks: request.recentHooks,
          maxDurationMs: request.maxDurationMs,
          forbidden: request.brand.forbidden,
          facts: factsOf(request),
        });
        const swipe: SwipeTestAnswer | null = await call("swipe_test", settings.judge, swipeUser(request, script, report), swipeTestAnswerSchema);
        draft = { script, report, swipe, leanIn: swipe ? leanInScore(evidencedScores(swipe)) : null };
        record.attempts.push(draft);
        if (!swipe) {
          record.error = "The swipe test returned no usable answer, so the draft could not be judged or revised.";
          break;
        }
        if (!report.blocked && swipe.verdict === "ship") break;
      }
    }

    // Final choice among the finished scripts.
    const finished = run.finalists
      .map((record) => ({ record, last: record.attempts.at(-1) }))
      .filter((entry): entry is { record: FinalistRecord; last: ScriptAttempt } => entry.last !== undefined && !entry.last.report.blocked);
    if (finished.length === 0) {
      reasons.push("No script passed the checks: every finalist still has a blocking finding.");
      return finish(run);
    }
    const shippable = finished.filter((entry) => entry.last.swipe?.verdict === "ship");
    for (const entry of finished.filter((candidate) => candidate.last.swipe?.verdict !== "ship")) {
      const line = `The swipe test would not ship the script of ${entry.record.conceptId} after ${entry.record.attempts.length} draft${entry.record.attempts.length === 1 ? "" : "s"}.`;
      (shippable.length === 0 ? reasons : notes).push(line);
    }
    const candidates = shippable.length > 0 ? shippable : finished;
    let winner = candidates[0]!;
    if (candidates.length > 1) {
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
    }
    run.chosen = { conceptId: winner.record.conceptId, script: winner.last.script, report: winner.last.report };
    run.status = reasons.length === 0 ? "ready" : "needs_person";
    return finish(run);
  } catch (error) {
    if (!(error instanceof CallBudget)) throw error;
    reasons.push(`The run reached its limit of ${settings.maxCalls} model calls before it finished.`);
    run.status = run.finalists.some((record) => record.attempts.some((attempt) => !attempt.report.blocked)) ? "needs_person" : "failed";
    return finish(run, true);
  }
}

function finish(run: DirectionRun, keepStatus = false): DirectionRun {
  if (!keepStatus && run.status !== "ready" && run.chosen === null) run.status = "failed";
  const costs = run.calls.map((record) => record.costUsd);
  run.costUsd = costs.some((cost) => cost === null || cost === undefined) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  return run;
}

type Caller = <T>(step: DirectionStep, slot: string, user: string, schema: z.ZodType<T>) => Promise<T | null>;

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

function conceptLabUser(request: DirectionRequest, cards: DeckCard[]): string {
  return [
    directionBlock(`${directionDirectives("script", { niche: request.niche })}\n\n${directionDirectives("agent")}`),
    untrustedBlock("brief", request.brief),
    untrustedBlock("brand", request.brand),
    untrustedBlock("audience", { notes: request.audience ?? "" }),
    untrustedBlock("trends", request.trends),
    untrustedBlock("cards", cards),
    untrustedBlock("limits", { maxDurationMs: request.maxDurationMs, language: request.language }),
  ].join("\n\n");
}

function panelUser(request: DirectionRequest, pairs: { pair: number; first: unknown; second: unknown }[]): string {
  return [`Audience notes are in the first block. Judge each pair as these viewers.`, untrustedBlock("audience", { notes: request.audience ?? "" }), untrustedBlock("pairs", pairs)].join("\n\n");
}

function directorUser(request: DirectionRequest, concept: Concept, draft: ScriptAttempt | null): string {
  const options = { format: concept.format, hookFamily: concept.hookFamily, niche: request.niche };
  const blocks = [
    directionBlock(`${directionDirectives("script", options)}\n\n${directionDirectives("visual", options)}\n\n${directionDirectives("voice", options)}`),
    untrustedBlock("concept", conceptItemForDirector(concept)),
    untrustedBlock("brief", request.brief),
    untrustedBlock("brand", request.brand),
    untrustedBlock("limits", { maxDurationMs: request.maxDurationMs, wordsPerMinute: request.wordsPerMinute ?? null, language: request.language }),
  ];
  if (draft) {
    blocks.push(
      untrustedBlock("draft", draft.script),
      untrustedBlock("findings", revisionNotes(draft.report)),
      untrustedBlock("critique", {
        risky: (draft.swipe?.windows ?? []).filter((window) => window.risk === "high").map((window) => ({ beatId: window.beatId, fromMs: window.fromMs, reason: window.reason })),
        fixes: draft.swipe?.fixes ?? [],
      }),
    );
  }
  return blocks.join("\n\n");
}

function conceptItemForDirector(concept: Concept): unknown {
  const { id: _id, source: _source, probability: _probability, ...seed } = concept;
  return seed;
}

function swipeUser(request: DirectionRequest, script: DirectedScript, report: DirectionReport): string {
  return [
    directionBlock(directionDirectives("critic")),
    untrustedBlock("audience", { notes: request.audience ?? "" }),
    untrustedBlock("script", script),
    untrustedBlock(
      "timeline",
      report.timeline.map((beat) => ({ beatId: beat.beatId, startMs: beat.startMs, endMs: beat.endMs })),
    ),
  ].join("\n\n");
}
