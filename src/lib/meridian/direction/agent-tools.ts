// Direction tools for an agent (scripts/direction.ts, the direction-scripts skill). Agent mode is the free way to direct a script: the
// agent writes the concepts and the scripts itself, as each role, and these tools give it exactly what a run gives a model (the pinned
// prompt, the direction block, the data blocks) and check what it writes with the same checks a run applies. Nothing here calls a
// provider, and nothing is stored: the files are the agent's.
//
// What agent mode does not have: a judge of another model family. The agent writes and judges with one model, which favours its own
// ideas (framework 3.3), so agent mode never ranks options by itself: it filters them with the same objective filters, checks them, and
// gives every option that passes to a person to choose, labelled as made in agent mode.

import { z } from "zod";
import { parseAnswer } from "./answers.ts";
import { DIRECTION_CODEX_VERSION, type NicheFamily } from "./codex.ts";
import { conceptLabAnswerSchema, creativeDeck, filterConcepts, poolConcepts, type ConceptDrop, type DeckCard } from "./concepts.ts";
import { directionUserMessage, reportFor, type DirectionRequest, type DirectorConcept, type ScriptAttempt } from "./pipeline.ts";
import { directionPrompt, type DirectionStep } from "./prompts.ts";
import type { DirectionReport } from "./report.ts";
import { directedScriptV2Schema, type DirectedScript } from "./script.ts";
import { directionNoteOf, scriptLinesOf, type ScriptLine } from "./scripts-view.ts";
import { NICHE_FAMILIES, VIDEO_JOBS } from "./lists.ts";

/** The direction request file an agent writes: the same shape a run is given (pipeline.ts DirectionRequest). */
export const directionRequestFileSchema = z.object({
  brief: z.object({ text: z.string().min(1).max(8000), sources: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(4000) })).max(20).default([]) }),
  brand: z.object({ name: z.string().max(200).default(""), claims: z.array(z.string().max(300)).max(40).default([]), forbidden: z.array(z.string().max(160)).max(60).default([]), tone: z.string().max(600).optional() }),
  audience: z.string().max(1500).optional(),
  niche: z.enum(NICHE_FAMILIES).optional(),
  language: z.string().min(2).max(16),
  maxDurationMs: z.int().min(5000).max(180_000),
  wordsPerMinute: z.number().min(80).max(260).optional(),
  recentHooks: z.array(z.string().max(300)).max(100).default([]),
  trends: z.array(z.object({ text: z.string().max(300), observedAt: z.string().min(4).max(40) })).max(40).default([]),
  job: z.enum(VIDEO_JOBS).optional(),
});

/** Reads a request file. A request that does not fit is refused with the field that does not. */
export function readRequest(raw: unknown): { ok: true; request: DirectionRequest } | { ok: false; error: string } {
  const parsed = directionRequestFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "request"}: ${issue?.message ?? "does not fit"}` };
  }
  return { ok: true, request: parsed.data as DirectionRequest };
}

/** An example request, for an agent to copy. Its product and numbers are invented for the example; a real brief replaces them. */
export function exampleRequest(): DirectionRequest {
  return {
    brief: {
      text: "EXAMPLE ONLY. A short video for our double-wall mug. We tested three mugs for two hours; coffee poured at 90 degrees; ours held 61. Only 1 stayed hot.",
      sources: [{ label: "review", text: "My coffee was still hot after two hours, unlike my old steel mug." }],
    },
    brand: { name: "Example mug brand", claims: ["Keeps drinks hot for two hours"], forbidden: [], tone: "plain and warm" },
    audience: "Office workers who forget their coffee",
    niche: "ecommerce",
    language: "en",
    maxDurationMs: 30_000,
    recentHooks: [],
    trends: [],
    job: "reach",
  };
}

/** The cards to write concepts on: a reproducible hand from the creative deck. */
export function dealCards(options: { count: number; seed: string; niche?: NicheFamily }): DeckCard[] {
  return creativeDeck(options);
}

/** A step's pinned prompt and the user message a run would send with it, so an agent can act as that role. */
export function roleMessage(
  input: Parameters<typeof directionUserMessage>[0],
): { promptId: string; promptHash: string; codexVersion: string; system: string; user: string } {
  const prompt = directionPrompt(input.step as DirectionStep);
  return { promptId: prompt.id, promptHash: prompt.hash, codexVersion: DIRECTION_CODEX_VERSION, system: prompt.text, user: directionUserMessage(input) };
}

/**
 * Filters an agent's concept-lab answers the way a run does: the obvious ideas it listed, the brand's recent hooks and near-duplicates
 * are dropped, each with why. Answers that do not fit the lab's contract are refused with their path.
 */
export function filterAnswers(
  request: DirectionRequest,
  answers: unknown[],
): { ok: true; kept: ReturnType<typeof poolConcepts>["concepts"]; dropped: ConceptDrop[]; obvious: string[] } | { ok: false; error: string } {
  const parsed = [];
  for (const [index, raw] of answers.entries()) {
    const answer = parseAnswer(JSON.stringify(raw), conceptLabAnswerSchema);
    if (!answer.ok) return { ok: false, error: `answer ${index + 1}: ${answer.error}` };
    parsed.push({ family: "agent", call: index, answer: answer.value });
  }
  const pool = poolConcepts(parsed);
  const filtered = filterConcepts(pool.concepts, { obvious: pool.obvious, recentHooks: request.recentHooks });
  return { ok: true, kept: filtered.kept, dropped: filtered.dropped, obvious: pool.obvious };
}

export type ScriptCheck =
  | { ok: false; error: string }
  | { ok: true; script: DirectedScript; report: DirectionReport; blocked: boolean; lines: ScriptLine[] };

/** Checks a script an agent wrote: the contract first, then every check a run applies. A blocked script must be revised. */
export function checkScript(request: DirectionRequest, raw: unknown): ScriptCheck {
  const parsed = parseAnswer(JSON.stringify(raw), directedScriptV2Schema);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const report = reportFor(request, parsed.value);
  return { ok: true, script: parsed.value, report, blocked: report.blocked, lines: scriptLinesOf(parsed.value) };
}

/** The draft a revision is given: the script and its report. An agent's own critique stands in for the swipe test, and says so. */
export function draftOf(request: DirectionRequest, script: DirectedScript): ScriptAttempt {
  return { script, report: reportFor(request, script), swipe: null, leanIn: null };
}

/** The director's message for a revision of an agent's draft, with the person's note. */
export function revisionMessage(request: DirectionRequest, concept: DirectorConcept, script: DirectedScript, note?: string) {
  return roleMessage({ step: "script_director", request, concept, draft: draftOf(request, script), note });
}

/**
 * What using a script gives: the script lines a draft takes (or the engine's script, `{ language, beats }`), and the direction note of
 * pictures, words on screen and sound. Refused for a blocked script.
 */
export function scriptForUse(request: DirectionRequest, raw: unknown, label = "made in agent mode"): { ok: true; lines: ScriptLine[]; engineScript: { language: string; beats: Array<{ beatId: string; role: string; text: string }> }; note: string } | { ok: false; error: string } {
  const checked = checkScript(request, raw);
  if (!checked.ok) return checked;
  if (checked.blocked) return { ok: false, error: "The script has a blocking finding. Revise it first." };
  if (checked.lines.length === 0) return { ok: false, error: "The script has no spoken line." };
  return {
    ok: true,
    lines: checked.lines,
    engineScript: { language: checked.script.language, beats: checked.lines.map((line, index) => ({ beatId: `b${index + 1}`, role: line.role, text: line.text })) },
    note: directionNoteOf(checked.script, label),
  };
}
